package main

import (
	"fmt"
	"sync"

	meshnet "github.com/BARGHEST-ngo/MESHnet"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type SendInfo struct {
	Address string `json:"address"`
	PIN     string `json:"pin"`
}

type SendService struct {
	mu  sync.Mutex
	srv *meshnet.Server
}

func (s *SendService) StartSend() (SendInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil {
		return SendInfo{}, fmt.Errorf("server already started")
	}

	srv := meshnet.NewServer(meshnet.ServerConfig{
		OnClientConnected: func(c meshnet.ClientInfo) {
			application.Get().Event.Emit("send:connected", c.Name)
		},
		OnClientDisconnected: func(c meshnet.ClientInfo, e error) {
			reason := ""
			if e != nil {
				reason = e.Error()
			}
			application.Get().Event.Emit("send:disconnected", reason)
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
	if s.srv == nil {
		return nil
	}
	err := s.srv.Stop()
	s.srv = nil
	return err
}

func (s *SendService) ServiceShutdown() error {
	return s.StopSend()
}
