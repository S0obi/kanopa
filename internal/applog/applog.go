// Package applog writes Kanopa's rotating log file. It never records secrets:
// attributes whose key looks like a password are dropped before writing.
package applog

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/natefinch/lumberjack.v2"
)

// Dir is where Kanopa keeps its logs: <user config dir>/Kanopa/logs.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Kanopa", "logs"), nil
}

// New returns a logger writing JSON lines to dir/kanopa.log (5 MB, 3 backups),
// plus text to extra when it is not nil (the console in development).
func New(dir string, extra io.Writer) (*slog.Logger, io.Closer, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	file := &lumberjack.Logger{
		Filename:   filepath.Join(dir, "kanopa.log"),
		MaxSize:    5,
		MaxBackups: 3,
	}
	opts := &slog.HandlerOptions{Level: slog.LevelInfo, ReplaceAttr: redact}
	var h slog.Handler = slog.NewJSONHandler(file, opts)
	if extra != nil {
		h = fanout{h, slog.NewTextHandler(extra, opts)}
	}
	return slog.New(h), file, nil
}

var secretKeys = []string{"password", "passwd", "secret", "token", "credential"}

func redact(_ []string, a slog.Attr) slog.Attr {
	k := strings.ToLower(a.Key)
	for _, s := range secretKeys {
		if strings.Contains(k, s) {
			return slog.Attr{}
		}
	}
	return a
}
