package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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
}

func (s *ReceiveService) Connect(address, pin string) error {
	var connected atomic.Bool
	s.mu.Lock()
	if s.client != nil && (s.client.State() == meshnet.StateConnected || s.client.State() == meshnet.StateConnecting) {
		s.mu.Unlock()
		return fmt.Errorf("already connected")
	}

	name, _ := os.Hostname()
	c := meshnet.NewClient(meshnet.ClientConfig{
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
				application.Get().Event.Emit("receive:disconnected", reason)
			}
		},
		OnMessage: func(m meshnet.Message) {
			if m.Topic == "offer" {
				var fileInfo FileInfo
				if err := json.Unmarshal(m.Data, &fileInfo); err != nil {
					// log error
					return
				}
				application.Get().Event.Emit("receive:offer", fileInfo)
			}
		},
	})
	s.client = c

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s.cancel = cancel
	s.mu.Unlock()

	if err := c.Connect(ctx); err != nil {
		s.mu.Lock()
		if s.client == c { // still ours? A Cancel + new Connect may have replaced it
			s.client = nil
			s.cancel = nil
		}
		s.mu.Unlock()
		return fmt.Errorf("connect: %w", err)
	}

	return nil
}

func (s *ReceiveService) CancelReceive() error {
	s.mu.Lock()
	c := s.client
	cancel := s.cancel

	s.client = nil
	s.cancel = nil
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

func (s *ReceiveService) Accept() error {
	s.mu.Lock()
	c := s.client
	s.mu.Unlock()
	if c == nil {
		return fmt.Errorf("not connected")
	}

	return c.Send(meshnet.Message{Topic: "accept"})
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
