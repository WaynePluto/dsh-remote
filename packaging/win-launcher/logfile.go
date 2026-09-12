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

	// 只保留一代备份，在 2 MiB 时轮换，因此两个文件最多占用
	// 4 MiB。它优于“无限追加”（stack 连续运行数
	// 周会填满磁盘）和每次运行生成日期文件（没人会清理这些文件）；
	// 在即将越过上限的写入时轮换，因此
	// 一次长时间运行与一百次短运行受到同样严格的限制。
	logSizeCapBytes = 2 << 20

	logTimeFormat = "2006-01-02 15:04:05"
)

// rotatingLog 是子进程 stdout 和 stderr 的去处。
//
// -H windowsgui 进程没有可供打印的控制台：不会分配控制台，
// 而托盘的目的正是不留下任何窗口。launcher 原本会在终端输出的所有内容
// 都必须保存在用户之后可以打开的位置，
// “查看日志”就是把这个位置交给 shell。
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
		// 无法重新打开的日志不能让 stack 停止；子进程仍在运行，
		// 从这里开始它的输出只会被丢弃。
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

// rotate 必须在持有锁时调用。
func (l *rotatingLog) rotate() {
	l.file.Close()
	l.file = nil
	os.Remove(l.backup)
	// 重命名可能失败，因为某个程序（编辑器、病毒扫描器）占用了
	// 文件。原地截断可以继续遵守上限，但代价是
	// 丢失日志较早的一半；这总比无限增长好。
	renamed := os.Rename(l.path, l.backup) == nil
	l.open(!renamed)
}

// printf 写入托盘自己的日志行。子进程输出会原样通过；
// launcher 的横幅使用框线字符，添加前缀会破坏它，因此用时间戳在文件中区分两者。
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

// lineWatcher 将子进程的字节原样传给日志，同时把
// 完整行交给回调；托盘借此得知控制台
// 尚无管理员，而无需重复解析输出。
type lineWatcher struct {
	sink   *rotatingLog
	onLine func(string)
	buffer []byte
}

// 超过此长度的内容不再视为一行；立即刷新，避免从不输出
// 换行符的子进程无限增大缓冲区。
const maxWatchedLineBytes = 64 * 1024

func (w *lineWatcher) Write(payload []byte) (int, error) {
	written, err := w.sink.Write(payload)
	if w.onLine != nil {
		w.scan(payload[:written])
	}
	return written, err
}

// scan 无需加锁：os/exec 为 stdout 和 stderr 各自提供
// goroutine 和 writer，因此每个缓冲区始终只有一个 goroutine 访问。
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
