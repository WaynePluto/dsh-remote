package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// Read the same way packages/launcher/src/config.ts reads it: from the
	// package root, unless --config points somewhere else.
	configFileName = "dsh-remote.config.json"

	// Defaults copied from packages/launcher/src/config.ts. A freshly unzipped
	// package has no config file at all, and the two menu items that open a
	// browser still have to point at the right ports.
	defaultDshPort   = 3080
	defaultRelayPort = 30809
	homeDirName      = ".dsh-remote"

	// Both URLs are loopback only: the console is reachable from the LAN too,
	// but this menu runs on the machine itself, and 铁律 11 makes 127.0.0.1 the
	// one authority that does not need a login.
	loopbackHost = "127.0.0.1"
)

// settings is the slice of the launcher's configuration the tray needs: two
// ports for the two URLs, and the home directory the log file lives in.
type settings struct {
	dshPort   int
	relayPort int
	home      string
	// The config file that was read; empty when built-in defaults are in use.
	path string
}

// rawConfig deliberately describes only those fields. The launcher validates
// the whole document with zod and refuses to start on anything it dislikes, so
// a second, stricter reader here could only ever disagree with it.
type rawConfig struct {
	Dsh *struct {
		Port *int `json:"port"`
	} `json:"dsh"`
	Relay *struct {
		Port *int `json:"port"`
	} `json:"relay"`
	Home *string `json:"home"`
}

func (s settings) consoleURL() string {
	return fmt.Sprintf("http://%s:%d", loopbackHost, s.relayPort)
}

func (s settings) dshURL() string {
	return fmt.Sprintf("http://%s:%d", loopbackHost, s.dshPort)
}

func (s settings) logPath() string {
	return filepath.Join(s.home, logFileName)
}

// loadSettings reads the config file, falling back to the documented defaults.
//
// A missing or broken file is never reported here: the launcher reads the very
// same file moments later and says precisely what is wrong with it, in the log.
// Refusing to show a tray icon over it would leave the user with no way to read
// that message.
func loadSettings(root string, arguments []string) settings {
	resolved := settings{dshPort: defaultDshPort, relayPort: defaultRelayPort, home: defaultHome(root)}
	path := configPath(root, arguments)
	data, err := os.ReadFile(path)
	if err != nil {
		return resolved
	}
	resolved.path = path
	var raw rawConfig
	if err := json.Unmarshal(data, &raw); err != nil {
		return resolved
	}
	if raw.Dsh != nil && raw.Dsh.Port != nil && validPort(*raw.Dsh.Port) {
		resolved.dshPort = *raw.Dsh.Port
	}
	if raw.Relay != nil && raw.Relay.Port != nil && validPort(*raw.Relay.Port) {
		resolved.relayPort = *raw.Relay.Port
	}
	if raw.Home != nil && *raw.Home != "" {
		resolved.home = expandHome(*raw.Home, root)
	}
	return resolved
}

func validPort(port int) bool {
	return port >= 1 && port <= 65535
}

// configPath honours a --config passed through to the launcher, so the log and
// the two URLs describe the stack that is actually running.
func configPath(root string, arguments []string) string {
	for index, argument := range arguments {
		if value, found := strings.CutPrefix(argument, "--config="); found {
			return expandHome(value, root)
		}
		if argument == "--config" && index+1 < len(arguments) {
			return expandHome(arguments[index+1], root)
		}
	}
	return filepath.Join(root, configFileName)
}

func defaultHome(root string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		// Without a home directory there is still a log to write; the package
		// root is the one directory this program is sure about.
		return filepath.Join(root, homeDirName)
	}
	return filepath.Join(home, homeDirName)
}

// expandHome mirrors the launcher's own path handling: a leading ~ is the user
// home, and a relative path is relative to the package root, because that is
// the working directory the launcher child is given.
func expandHome(path string, root string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return root
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(root, path)
}
