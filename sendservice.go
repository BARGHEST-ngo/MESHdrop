package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	meshnet "github.com/BARGHEST-ngo/MESHnet"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type progressWriter struct {
	w      io.Writer
	n      int64
	last   time.Time
	report func(n int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.n += int64(n)
	if time.Since(p.last) >= 100*time.Millisecond {
		p.last = time.Now()
		p.report(p.n)
	}
	return n, err
}

type SendInfo struct {
	Address string `json:"address"`
	PIN     string `json:"pin"`
}

type FileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type SendService struct {
	mu   sync.Mutex
	srv  *meshnet.Server
	path string
}

func (s *SendService) StartSend() (SendInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return SendInfo{}, fmt.Errorf("choose a file first")
	}

	if s.srv != nil {
		return SendInfo{}, fmt.Errorf("server already started")
	}

	path := s.path
	var srv *meshnet.Server
	var offered FileInfo
	var sending bool
	srv = meshnet.NewServer(meshnet.ServerConfig{
		OnClientConnected: func(c meshnet.ClientInfo) {
			emit("send:connected", c.Name)
			info, err := os.Stat(path)
			if err != nil {
				// log error
				srv.DisconnectClient(c.ID)
				return
			}
			offered = FileInfo{Name: filepath.Base(path), Size: info.Size()}
			data, err := json.Marshal(offered)
			if err != nil {
				// log err
				srv.DisconnectClient(c.ID)
				return
			}
			srv.Send(c.ID, meshnet.Message{Topic: "offer", Data: data})
		},
		OnClientDisconnected: func(c meshnet.ClientInfo, e error) {
			reason := ""
			if e != nil {
				reason = e.Error()
			}
			emit("send:disconnected", reason)
		},
		OnMessage: func(clientID string, m meshnet.Message) {
			switch m.Topic {
			case "accept":
				if sending {
					return
				}
				sending = true
				emit("send:accepted", nil)
				go sendFile(srv, clientID, path, offered.Size)
			case "decline":
				emit("send:declined", nil)
			case "received":
				emit("send:complete", nil)
			}
		},
	})

	addr, err := srv.Start()
	if err != nil {
		return SendInfo{}, fmt.Errorf("server start: %w", err)
	}

	pin, err := srv.NewPairing()
	if err != nil {
		srv.Stop()
		return SendInfo{}, fmt.Errorf("new pairing: %w", err)
	}
	s.srv = srv
	info := SendInfo{
		Address: addr,
		PIN:     pin,
	}
	return info, nil
}

func sendFile(srv *meshnet.Server, clientID, path string, size int64) {
	fail := func(err error) {
		emit("send:failed", err.Error())
		srv.DisconnectClient(clientID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream, err := srv.RequestStream(ctx, clientID, "file")
	if err != nil {
		fail(fmt.Errorf("open stream: %w", err))
		return
	}
	defer stream.Close()

	f, err := os.Open(path)
	if err != nil {
		fail(err)
		return
	}
	defer f.Close()

	pw := &progressWriter{
		w:      stream,
		report: func(n int64) { emit("send:progress", n) },
	}
	if _, err := io.CopyN(pw, f, size); err != nil {
		fail(fmt.Errorf("send: %w", err))
		return
	}
	emit("send:progress", size)
}

func emit(evt string, payload any) {
	application.Get().Event.Emit(evt, payload)
}

func (s *SendService) StopSend() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.path = ""
	if s.srv == nil {
		return nil
	}
	err := s.srv.Stop()
	s.srv = nil
	return err
}

func (s *SendService) ChooseFile() (FileInfo, error) {
	path, err := application.Get().Dialog.OpenFile().
		CanChooseFiles(true).SetTitle("Choose a file to send").
		PromptForSingleSelection()

	if err != nil {
		return FileInfo{}, fmt.Errorf("choose file: %w", err)
	}

	if path == "" {
		return FileInfo{}, nil
	}

	info, err := os.Stat(path)
	if err != nil {
		return FileInfo{}, fmt.Errorf("stat: %w", err)
	}

	if info.IsDir() {
		return FileInfo{}, fmt.Errorf("%s is a folder, choose a file", filepath.Base(path))
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil {
		return FileInfo{}, fmt.Errorf("a send is already in progress")
	}
	s.path = path

	return FileInfo{
		Name: filepath.Base(path),
		Size: info.Size(),
	}, nil
}

func (s *SendService) ServiceShutdown() error {
	return s.StopSend()
}
