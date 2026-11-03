package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	meshnet "github.com/BARGHEST-ngo/MESHnet"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type ReceiveService struct {
	mu     sync.Mutex
	client *meshnet.Client
	cancel context.CancelFunc
	sess   *receiveSession
}

type receiveSession struct {
	mu    sync.Mutex
	offer *FileInfo
	dst   string
}

func (s *ReceiveService) Connect(address, pin string) error {
	var connected atomic.Bool
	s.mu.Lock()
	if s.client != nil && (s.client.State() == meshnet.StateConnected || s.client.State() == meshnet.StateConnecting) {
		s.mu.Unlock()
		return fmt.Errorf("already connected")
	}

	name, _ := os.Hostname()
	sess := &receiveSession{}
	var c *meshnet.Client
	c = meshnet.NewClient(meshnet.ClientConfig{
		ServerAddr: address,
		PairingPIN: pin,
		Name:       name,
		OnStateChange: func(state meshnet.State, e error) {
			if state == meshnet.StateConnected {
				connected.Store(true)
				return
			}
			if !connected.Load() {
				return
			}
			if state == meshnet.StateDisconnected || state == meshnet.StateErrored {
				reason := ""
				if e != nil {
					reason = e.Error()
				}
				emit("receive:disconnected", reason)
			}
		},
		OnMessage: func(m meshnet.Message) {
			if m.Topic != "offer" {
				return
			}
			var offer FileInfo
			if err := json.Unmarshal(m.Data, &offer); err != nil || offer.Size < 0 {
				// log error
				return
			}
			sess.mu.Lock()
			sess.offer = &offer
			sess.dst = ""
			sess.mu.Unlock()
			emit("receive:offer", offer)
		},
		OnStreamRequest: func(target string, stream net.Conn) {
			defer stream.Close()
			if target != "file" {
				return
			}
			sess.mu.Lock()
			offer := sess.offer
			dst := sess.dst
			sess.dst = ""
			sess.mu.Unlock()
			if offer == nil || dst == "" {
				return
			}

			if err := receiveFile(stream, dst, offer.Size); err != nil {
				emit("receive:failed", err.Error())
				return
			}

			c.Send(meshnet.Message{Topic: "received"})
			emit("receive:complete", nil)
		},
	})
	s.client = c
	s.sess = sess

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s.cancel = cancel
	s.mu.Unlock()

	if err := c.Connect(ctx); err != nil {
		s.mu.Lock()
		if s.client == c { // still ours? A Cancel + new Connect may have replaced it
			s.client = nil
			s.cancel = nil
			s.sess = nil
		}
		s.mu.Unlock()
		return fmt.Errorf("connect: %w", err)
	}

	return nil
}

func receiveFile(r io.Reader, dest string, size int64) (err error) {
	part := dest + ".part"
	f, err := os.OpenFile(part, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			os.Remove(part)
		}
	}()

	_, err = io.CopyN(f, r, size) // don't wait for EOF (see the close gap)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(part, dest)
}

func safeName(name string) string {
	n := filepath.Base(name)
	if n == "" || n == "." || n == ".." || n == string(filepath.Separator) {
		return "download"
	}
	return n
}

func (s *ReceiveService) CancelReceive() error {
	s.mu.Lock()
	c := s.client
	cancel := s.cancel

	s.client = nil
	s.cancel = nil
	s.sess = nil
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	var err error
	if c != nil {
		err = c.Disconnect()
	}

	return err
}

func (s *ReceiveService) Accept() (bool, error) {
	s.mu.Lock()
	c := s.client
	sess := s.sess
	s.mu.Unlock()
	if c == nil || sess == nil {
		return false, fmt.Errorf("not connected")
	}

	sess.mu.Lock()
	offer := sess.offer
	sess.mu.Unlock()
	if offer == nil {
		return false, fmt.Errorf("no offer")
	}

	dst, err := application.Get().Dialog.SaveFile().
		SetFilename(safeName(offer.Name)).
		PromptForSingleSelection()
	if err != nil || dst == "" {
		return false, err
	}

	sess.mu.Lock()
	sess.dst = dst
	sess.mu.Unlock()
	return true, c.Send(meshnet.Message{Topic: "accept"})
}

func (s *ReceiveService) Decline() error {
	s.mu.Lock()
	c := s.client
	s.mu.Unlock()
	if c == nil {
		return fmt.Errorf("not connected")
	}

	return c.Send(meshnet.Message{Topic: "decline"})
}

func (s *ReceiveService) ServiceShutdown() error {
	return s.CancelReceive()
}
