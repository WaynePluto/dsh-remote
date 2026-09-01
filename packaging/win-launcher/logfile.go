package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	logFileName = "dsh-remote.log"

	// One backup generation, swapped at 2 MiB, so the pair can never take more
	// than 4 MiB. Chosen over both "append forever" (a stack left running for
	// weeks would fill the disk) and a dated file per run (nobody cleans those
	// up either). Rotation happens on the write that would cross the line, so a
	// single long run is capped just as tightly as a hundred short ones.
	logSizeCapBytes = 2 << 20

	logTimeFormat = "2006-01-02 15:04:05"
)

// rotatingLog is where the children's stdout and stderr end up.
//
// A -H windowsgui process has nowhere to print: no console is allocated, and
// the whole point of the tray is that no window is left open. Everything the
// launcher would have said in a terminal has to survive somewhere the user can
// open later, which is what 查看日志 hands to the shell.
type rotatingLog struct {
	mu     sync.Mutex
	path   string
	backup string
	file   *os.File
	size   int64
}

func openLog(path string) (*rotatingLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	log := &rotatingLog{path: path, backup: path + ".1"}
	if err := log.open(false); err != nil {
		return nil, err
	}
	return log, nil
}

func (l *rotatingLog) open(truncate bool) error {
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if truncate {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	file, err := os.OpenFile(l.path, flags, 0o644)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	l.file = file
	l.size = info.Size()
	return nil
}

func (l *rotatingLog) Write(payload []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		// A log that could not be reopened must not stop the stack; the child is
		// still running and its output is simply dropped from here on.
		return len(payload), nil
	}
	if l.size+int64(len(payload)) > logSizeCapBytes {
		l.rotate()
		if l.file == nil {
			return len(payload), nil
		}
	}
	written, err := l.file.Write(payload)
	l.size += int64(written)
	return written, err
}

// rotate must be called with the lock held.
func (l *rotatingLog) rotate() {
	l.file.Close()
	l.file = nil
	os.Remove(l.backup)
	// A rename can fail because something (an editor, a virus scanner) holds the
	// file open. Truncating in place then keeps the cap honest, at the cost of
	// the older half of the log — better than growing without bound.
	renamed := os.Rename(l.path, l.backup) == nil
	l.open(!renamed)
}

// printf writes one of the tray's own lines. Child output goes through
// unchanged — the launcher's banner is a box drawing and a prefix would tear it
// apart — so a timestamp is what tells the two apart in the file.
func (l *rotatingLog) printf(format string, arguments ...any) {
	line := fmt.Sprintf("%s [tray] %s\n", time.Now().Format(logTimeFormat), fmt.Sprintf(format, arguments...))
	l.Write([]byte(line))
}

func (l *rotatingLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return
	}
	l.file.Close()
	l.file = nil
}

// lineWatcher passes the child's bytes straight to the log while also handing
// complete lines to a callback, which is how the tray notices that the console
// has no administrator yet without parsing anything twice.
type lineWatcher struct {
	sink   *rotatingLog
	onLine func(string)
	buffer []byte
}

// A line this long is not a line; flush it so a child that never emits a
// newline cannot grow this buffer without bound.
const maxWatchedLineBytes = 64 * 1024

func (w *lineWatcher) Write(payload []byte) (int, error) {
	written, err := w.sink.Write(payload)
	if w.onLine != nil {
		w.scan(payload[:written])
	}
	return written, err
}

// scan is safe without a lock: os/exec gives each of stdout and stderr its own
// goroutine and its own writer, so only one goroutine ever touches one buffer.
func (w *lineWatcher) scan(payload []byte) {
	w.buffer = append(w.buffer, payload...)
	for {
		index := bytes.IndexByte(w.buffer, '\n')
		if index < 0 {
			break
		}
		line := bytes.TrimSuffix(w.buffer[:index], []byte("\r"))
		w.onLine(string(line))
		w.buffer = w.buffer[index+1:]
	}
	if len(w.buffer) > maxWatchedLineBytes {
		w.onLine(string(w.buffer))
		w.buffer = w.buffer[:0]
	}
}
