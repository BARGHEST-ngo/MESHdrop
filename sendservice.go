package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	meshnet "github.com/BARGHEST-ngo/MESHnet"
	"github.com/wailsapp/wails/v3/pkg/application"
)

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
	if s.path == "" {
		return SendInfo{}, fmt.Errorf("choose a file first")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil {
		return SendInfo{}, fmt.Errorf("server already started")
	}

	path := s.path
	var srv *meshnet.Server
	srv = meshnet.NewServer(meshnet.ServerConfig{
		OnClientConnected: func(c meshnet.ClientInfo) {
			application.Get().Event.Emit("send:connected", c.Name)
			info, err := os.Stat(path)
			if err != nil {
				// log error
				srv.DisconnectClient(c.ID)
				return
			}
			data, err := json.Marshal(FileInfo{Name: filepath.Base(path), Size: info.Size()})
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
			application.Get().Event.Emit("send:disconnected", reason)
		},
		OnMessage: func(clientID string, m meshnet.Message) {
			switch m.Topic {
			case "accept":
				application.Get().Event.Emit("send:accepted")
			case "decline":
				application.Get().Event.Emit("send:declined")
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
