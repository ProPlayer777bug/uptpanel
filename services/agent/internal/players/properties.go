// Minecraft server.properties reading + editing. The AI assistant ("AIBro")
// and the server configuration editor both use this to let a user change
// settings like online-mode without touching the files by hand. Only a small
// allow-list of properties is editable, each with strict value validation, so
// a model or a human cannot brick a server or escape the data directory.
package players

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// PropVal is one editable property definition.
type PropVal struct {
	Key     string `json:"key"`
	Type    string `json:"type"`              // bool|int|enum|string
	Min     int    `json:"min,omitempty"`     // int minimum
	Max     int    `json:"max,omitempty"`     // int maximum
	Options []string `json:"options,omitempty"` // enum choices
	Default string `json:"default,omitempty"`
	Help    string `json:"help,omitempty"`
}

// EditableProps is the allow-list of server.properties keys the panel may set.
var EditableProps = []PropVal{
	{Key: "online-mode", Type: "bool", Default: "true", Help: "Require Minecraft account authentication (join mode)."},
	{Key: "white-list", Type: "bool", Default: "false", Help: "Only whitelisted players may join."},
	{Key: "enforce-whitelist", Type: "bool", Default: "false", Help: "Kick players added after whitelist is enforced."},
	{Key: "gamemode", Type: "enum", Options: []string{"survival", "creative", "adventure", "spectator"}, Default: "survival"},
	{Key: "force-gamemode", Type: "bool", Default: "false", Help: "Force players to the server gamemode."},
	{Key: "difficulty", Type: "enum", Options: []string{"peaceful", "easy", "normal", "hard"}, Default: "easy"},
	{Key: "max-players", Type: "int", Min: 1, Max: 1000, Default: "20"},
	{Key: "motd", Type: "string", Default: "A Minecraft Server", Help: "Message of the day shown on join."},
	{Key: "pvp", Type: "bool", Default: "true"},
	{Key: "allow-flight", Type: "bool", Default: "false", Help: "Allow players to fly without the anti-cheat kicking them."},
	{Key: "hardcore", Type: "bool", Default: "false", Help: "Permadeath: hard difficulty + ban on death."},
	{Key: "spawn-protection", Type: "int", Min: 0, Max: 65536, Default: "16"},
	{Key: "view-distance", Type: "int", Min: 2, Max: 128, Default: "10"},
	{Key: "simulation-distance", Type: "int", Min: 3, Max: 64, Default: "10"},
	{Key: "max-world-size", Type: "int", Min: 1, Max: 10000, Default: "29999984"},
	{Key: "generate-structures", Type: "bool", Default: "true"},
	{Key: "spawn-monsters", Type: "bool", Default: "true"},
	{Key: "spawn-animals", Type: "bool", Default: "true"},
	{Key: "spawn-npcs", Type: "bool", Default: "true"},
	{Key: "level-seed", Type: "string", Default: "", Help: "World seed (applies to a fresh world)."},
	{Key: "enable-command-blocks", Type: "bool", Default: "false"},
	{Key: "network-compression-threshold", Type: "int", Min: -1, Max: 65536, Default: "256"},
	{Key: "max-tick-time", Type: "int", Min: 0, Max: 600000, Default: "60000"},
}

func editableByKey(key string) *PropVal {
	for i := range EditableProps {
		if EditableProps[i].Key == key {
			return &EditableProps[i]
		}
	}
	return nil
}

// PropertiesSnapshot returns the current values of the editable allow-list.
func PropertiesSnapshot(dir string) (map[string]string, error) {
	path := filepath.Join(dir, "server.properties")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cur := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		cur[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	out := map[string]string{}
	for _, p := range EditableProps {
		if v, ok := cur[p.Key]; ok {
			out[p.Key] = v
		} else {
			out[p.Key] = p.Default
		}
	}
	return out, nil
}

// ValidateProperty checks a value against the allow-list definition.
func ValidateProperty(key, value string) error {
	def := editableByKey(key)
	if def == nil {
		return fmt.Errorf("property %q is not editable", key)
	}
	v := strings.TrimSpace(value)
	switch def.Type {
	case "bool":
		if v != "true" && v != "false" {
			return fmt.Errorf("%s must be true or false", key)
		}
	case "int":
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("%s must be a number", key)
		}
		if def.Min != 0 && n < def.Min {
			return fmt.Errorf("%s must be at least %d", key, def.Min)
		}
		if def.Max != 0 && n > def.Max {
			return fmt.Errorf("%s must be at most %d", key, def.Max)
		}
	case "enum":
		ok := false
		for _, o := range def.Options {
			if v == o {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%s must be one of %s", key, strings.Join(def.Options, ", "))
		}
	case "string":
		if len(v) > 100 {
			return fmt.Errorf("%s is too long (max 100 characters)", key)
		}
		if key == "motd" && strings.ContainsAny(v, "\n\r") {
			return fmt.Errorf("motd cannot contain line breaks")
		}
	}
	return nil
}

// SetProperty updates a single allow-listed property in server.properties.
func SetProperty(dir, key, value string) error {
	if err := ValidateProperty(key, value); err != nil {
		return err
	}
	path := filepath.Join(dir, "server.properties")
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	found := false
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 && strings.TrimSpace(parts[0]) == key {
			lines[i] = key + "=" + value
			found = true
			break
		}
	}
	if !found {
		lines = append(lines, key+"="+value)
	}
	// Make sure the file ends in exactly one newline.
	out := strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
	return os.WriteFile(path, []byte(out), 0o644)
}