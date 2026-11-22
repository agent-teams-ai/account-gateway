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
	"time"
	"unsafe"
)

var marker = []byte("gateway-owned-memory-control")

type procMemoryReceipt struct {
	PIDNumbersMatch bool   `json:"pidNumbersMatch"`
	ReadOpen        string `json:"readOpen"`
	ReadWriteOpen   string `json:"readWriteOpen"`
}

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

func procMemoryOpen(path string, flags int) string {
	mem, err := os.OpenFile(path, flags, 0)
	if mem != nil {
		_ = mem.Close()
	}
	if pathErr, ok := err.(*os.PathError); ok {
		err = pathErr.Err
	}
	switch err {
	case nil:
		return "opened"
	case syscall.EPERM:
		return "eperm"
	case syscall.EACCES:
		return "eacces"
	case syscall.EROFS:
		return "erofs"
	default:
		return "other"
	}
}

func procPermissionDenied(result string) bool { return result == "eperm" || result == "eacces" }

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

type reapingReceipt struct {
	Kind   string          `json:"kind"`
	Checks map[string]bool `json:"checks"`
	Pass   bool            `json:"pass"`
}

// Only inspect the descendant PID delivered by our own intermediate child.
// A start-time comparison also avoids mistaking PID reuse for a retained child.
func ownedProcess(pid int) (int, string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, "", err
	}
	end := strings.LastIndex(string(data), ")")
	fields := strings.Fields(string(data)[end+1:])
	if end < 0 || len(fields) < 20 {
		return 0, "", syscall.EINVAL
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, "", err
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return 0, "", err
	}
	return parent, fields[19], nil
}

func checkReaping() reapingReceipt {
	checks := map[string]bool{
		"initPID1": false, "initReadOnly": false, "ownedOrphanStarted": false,
		"ownedOrphanAdopted": false, "ownedOrphanReaped": false,
	}
	receipt := reapingReceipt{"gateway-execution-reaping-probe/v1", checks, false}
	// Moby d3298094 daemon/oci_linux.go mounts DefaultInitBinary here read-only.
	// Debian usrmerge resolves /sbin to /usr/sbin. Accept only these two exact
	// canonical locations, then bind both observations to the resolved file.
	// Existing AppArmor inheritance applies; no new execute grant is needed.
	const initPath = "/sbin/docker-init"
	canonicalInit, pathErr := filepath.EvalSymlinks(initPath)
	knownInitPath := pathErr == nil && (canonicalInit == initPath || canonicalInit == "/usr/sbin/docker-init")
	init, err := os.Readlink("/proc/1/exe")
	checks["initPID1"] = knownInitPath && err == nil && init == canonicalInit
	if data, err := os.ReadFile("/proc/self/mountinfo"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if knownInitPath && len(fields) > 5 && fields[4] == canonicalInit {
				checks["initReadOnly"] = strings.Contains(","+fields[5]+",", ",ro,")
			}
		}
	}
	input, release, err := os.Pipe()
	if err != nil {
		return receipt
	}
	defer input.Close()
	defer release.Close()
	parent := exec.Command(os.Args[0], "orphan-parent")
	parent.Stdin = input
	output, err := parent.StdoutPipe()
	if err != nil || parent.Start() != nil {
		return receipt
	}
	defer func() { _ = parent.Process.Kill(); _ = parent.Wait() }()
	// This manually owned pipe stays open after the intermediate parent exits.
	// Its child cannot exit until adoption has been observed by this controller.
	_ = input.Close()
	line, err := bufio.NewReader(io.LimitReader(output, 32)).ReadString('\n')
	if err != nil || parent.Wait() != nil {
		return receipt
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || pid <= 1 || pid == parent.Process.Pid {
		return receipt
	}
	checks["ownedOrphanStarted"] = true
	ppid, started, err := ownedProcess(pid)
	if err != nil {
		return receipt
	}
	checks["ownedOrphanAdopted"] = ppid == 1
	_ = release.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, currentStart, err := ownedProcess(pid)
		if os.IsNotExist(err) || (err == nil && currentStart != started) {
			checks["ownedOrphanReaped"] = true
			break
		}
		if err != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	receipt.Pass = true
	for _, check := range checks {
		receipt.Pass = receipt.Pass && check
	}
	return receipt
}

func main() {
	if len(os.Args) == 2 {
		switch os.Args[1] {
		case "orphan-parent":
			child := exec.Command(os.Args[0], "orphan-child")
			child.Stdin = os.Stdin
			if child.Start() != nil {
				fatal()
			}
			fmt.Println(child.Process.Pid)
			return
		case "orphan-child":
			var release [1]byte
			_, _ = os.Stdin.Read(release[:])
			return
		case "reaping":
			receipt := checkReaping()
			if json.NewEncoder(os.Stdout).Encode(receipt) != nil {
				fatal()
			}
			if !receipt.Pass {
				os.Exit(1)
			}
			return
		}
	}
	if len(os.Args) == 2 && os.Args[1] == "target" {
		// A retained procfs can use an ancestor PID namespace. Its own self link
		// identifies this child in that mount without guessing another task's PID.
		procSelf, err := os.Readlink("/proc/self")
		if err != nil {
			fatal()
		}
		procPID, err := strconv.Atoi(procSelf)
		if err != nil || procPID < 1 || strconv.Itoa(procPID) != procSelf {
			fatal()
		}
		fmt.Printf("%d %d %d\n", os.Getpid(), procPID, uintptr(unsafe.Pointer(&marker[0])))
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
	var pid, procPID int
	var address uintptr
	if n, err := fmt.Sscanf(line, "%d %d %d", &pid, &procPID, &address); err != nil || n != 3 || len(strings.Fields(line)) != 3 || pid != cmd.Process.Pid || procPID < 1 || address == 0 {
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
	procPath := fmt.Sprintf("/proc/%d/mem", procPID)
	procMemory := procMemoryReceipt{pid == procPID, procMemoryOpen(procPath, os.O_RDONLY), procMemoryOpen(procPath, os.O_RDWR)}
	// A read-only mount can refuse O_RDWR before the LSM. It qualifies only
	// together with an independently denied read-only open of this same child.
	checks["procMemoryDenied"] = procPermissionDenied(procMemory.ReadOpen) &&
		(procPermissionDenied(procMemory.ReadWriteOpen) || procMemory.ReadWriteOpen == "erofs")
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
		Kind       string            `json:"kind"`
		Phase      string            `json:"phase"`
		UID        int               `json:"uid"`
		Profile    string            `json:"profile"`
		Checks     map[string]bool   `json:"checks"`
		ProcMemory procMemoryReceipt `json:"procMemory"`
		Pass       bool              `json:"pass"`
	}{"gateway-execution-probe/v1", phase, os.Getuid(), label, checks, procMemory, pass}
	if err := json.NewEncoder(os.Stdout).Encode(receipt); err != nil {
		fatal()
	}
	if !pass {
		os.Exit(1)
	}
}
