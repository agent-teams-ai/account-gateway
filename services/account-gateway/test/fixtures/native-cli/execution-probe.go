//go:build linux && amd64

// Synthetic checks for one owned CI container. Never target unrelated tasks.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var marker = []byte("gateway-owned-memory-control")

func denied(err error) bool {
	return err == syscall.EPERM || err == syscall.EACCES
}

func fsDenied(err error) bool {
	if e, ok := err.(*os.PathError); ok {
		err = e.Err
	}
	return denied(err) || err == syscall.EROFS
}

func value(status, key string) string {
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(line, key+":"))
		}
	}
	return ""
}

func fatal() { fmt.Fprintln(os.Stderr, "execution-probe-invalid"); os.Exit(1) }

func userNamespaceDenied() bool {
	// unshare(CLONE_NEWUSER) can fail EINVAL for Go's multi-threaded runtime
	// before consulting the LSM. A raw fork-like clone has no such prerequisite.
	pid, _, err := syscall.RawSyscall(syscall.SYS_CLONE, syscall.CLONE_NEWUSER|uintptr(syscall.SIGCHLD), 0, 0)
	if err == 0 && pid == 0 {
		// No Go runtime operations are safe in this fork child.
		syscall.RawSyscall(syscall.SYS_EXIT, 0, 0, 0)
		for {
		}
	}
	if err == 0 {
		var status syscall.WaitStatus
		_, _ = syscall.Wait4(int(pid), &status, 0, nil)
	}
	return denied(err)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "target" {
		fmt.Printf("%d %d\n", os.Getpid(), uintptr(unsafe.Pointer(&marker[0])))
		_, _ = io.Copy(io.Discard, os.Stdin)
		runtime.KeepAlive(marker)
		return
	}
	if len(os.Args) != 7 {
		fatal()
	}
	phase, expectedLabel, canary, workspace, outside, port := os.Args[1], os.Args[2], os.Args[3], os.Args[4], os.Args[5], os.Args[6]
	if (phase != "outer" && phase != "payload") || !filepath.IsAbs(canary) || !filepath.IsAbs(workspace) || !filepath.IsAbs(outside) {
		fatal()
	}
	statusBytes, err := os.ReadFile("/proc/self/status")
	if err != nil {
		fatal()
	}
	status := string(statusBytes)
	labelBytes, err := os.ReadFile("/proc/self/attr/current")
	if err != nil {
		fatal()
	}
	label := strings.TrimSpace(string(labelBytes))
	capEff, err := strconv.ParseUint(value(status, "CapEff"), 16, 64)
	if err != nil {
		fatal()
	}
	capBnd, err := strconv.ParseUint(value(status, "CapBnd"), 16, 64)
	if err != nil {
		fatal()
	}
	checks := map[string]bool{
		"enforcedProfile":   label == expectedLabel+" (enforce)",
		"seccompFilter":     value(status, "Seccomp") == "2",
		"noInitialSysAdmin": capBnd&(1<<21) == 0 && capEff&(1<<21) == 0,
	}
	if phase == "payload" {
		checks["noNewPrivileges"] = value(status, "NoNewPrivs") == "1"
	}
	content, err := os.ReadFile(canary)
	checks["canaryRead"] = err == nil && string(content) == "gateway-profile-read-control\n"
	checks["userNamespaceDenied"] = userNamespaceDenied()
	checks["mountDenied"] = denied(syscall.Mount("none", workspace, "tmpfs", 0, ""))
	if !checks["mountDenied"] {
		_ = syscall.Unmount(workspace, 0)
	}
	checks["immutableWriteDenied"] = fsDenied(os.WriteFile(canary, []byte("must-not-write"), 0600))
	checks["immutableModeDenied"] = fsDenied(os.Chmod(canary, 0400))
	if phase == "payload" {
		for name, path := range map[string]string{"workspace": workspace, "outside": outside} {
			checks[name+"WriteDenied"] = fsDenied(os.WriteFile(filepath.Join(path, "must-not-write"), []byte("denied"), 0600))
			checks[name+"ModeDenied"] = fsDenied(os.Chmod(filepath.Join(path, "mutable-control"), 0400))
		}
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			fatal()
		}
		fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
		if err == nil {
			err = syscall.Connect(fd, &syscall.SockaddrInet4{Port: p, Addr: [4]byte{127, 0, 0, 1}})
			_ = syscall.Close(fd)
		}
		checks["loopbackDenied"] = denied(err)
	}
	// All memory/trace attempts target this probe's own direct child, whose PID
	// and valid memory address are received over a private anonymous pipe.
	cmd := exec.Command(os.Args[0], "target")
	input, err := cmd.StdinPipe()
	if err != nil {
		fatal()
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		fatal()
	}
	if err = cmd.Start(); err != nil {
		fatal()
	}
	defer func() { _ = input.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	line, err := bufio.NewReader(io.LimitReader(output, 128)).ReadString('\n')
	if err != nil {
		fatal()
	}
	var pid int
	var address uintptr
	if n, err := fmt.Sscanf(line, "%d %d", &pid, &address); err != nil || n != 2 || pid != cmd.Process.Pid || address == 0 {
		fatal()
	}
	checks["ownedChildAlive"] = syscall.Kill(pid, 0) == nil
	local := []byte{'g'}
	localVec := syscall.Iovec{Base: &local[0], Len: 1}
	remoteVec := struct {
		Base uintptr
		Len  uint64
	}{Base: address, Len: 1}
	_, _, e := syscall.Syscall6(310, uintptr(pid), uintptr(unsafe.Pointer(&localVec)), 1, uintptr(unsafe.Pointer(&remoteVec)), 1, 0)
	checks["processMemoryReadDenied"] = denied(e)
	_, _, e = syscall.Syscall6(311, uintptr(pid), uintptr(unsafe.Pointer(&localVec)), 1, uintptr(unsafe.Pointer(&remoteVec)), 1, 0)
	checks["processMemoryWriteDenied"] = denied(e)
	mem, err := os.OpenFile(fmt.Sprintf("/proc/%d/mem", pid), os.O_RDWR, 0)
	if mem != nil {
		_ = mem.Close()
	}
	if pathErr, ok := err.(*os.PathError); ok {
		err = pathErr.Err
	}
	checks["procMemoryDenied"] = denied(err)
	err = syscall.PtraceAttach(pid)
	checks["ptraceDenied"] = denied(err)
	if err == nil {
		var wait syscall.WaitStatus
		_, _ = syscall.Wait4(pid, &wait, 0, nil)
		_ = syscall.PtraceDetach(pid)
	}
	pass := true
	for _, check := range checks {
		pass = pass && check
	}
	receipt := struct {
		Kind    string          `json:"kind"`
		Phase   string          `json:"phase"`
		UID     int             `json:"uid"`
		Profile string          `json:"profile"`
		Checks  map[string]bool `json:"checks"`
		Pass    bool            `json:"pass"`
	}{"gateway-execution-probe/v1", phase, os.Getuid(), label, checks, pass}
	if err := json.NewEncoder(os.Stdout).Encode(receipt); err != nil {
		fatal()
	}
	if !pass {
		os.Exit(1)
	}
}
