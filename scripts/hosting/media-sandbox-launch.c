/* Unprivileged pre-exec containment trampoline. Build/package root-owned 0555.
 * argv: openFiles runtimeRoot (ffprobe|ffmpeg) toolArgs...
 * stdin: O_RDONLY regular input; fd3:cgroup.procs; fd4:gate; fd5:ready.
 * No media decoder or namespace child exists before this process joins cgroup. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <sched.h>

static void stop(void) { _exit(125); }
static void limit(int which, rlim_t value) {
  struct rlimit bound = {value,value}; if (setrlimit(which,&bound)) stop();
}
int main(int argc, char **argv) {
  if (argc < 4 || argc > 260 || getuid()==0 || getuid()!=geteuid() || getgid()!=getegid()) stop();
  char *end; errno=0; unsigned long fds=strtoul(argv[1],&end,10);
  if (errno || *end || fds<16 || fds>128 || argv[2][0]!='/' || strstr(argv[2],"/../") || strlen(argv[2])>4096) stop();
  const char *program=!strcmp(argv[3],"ffprobe")?"/bin/ffprobe":!strcmp(argv[3],"ffmpeg")?"/bin/ffmpeg":NULL;
  if (!program) stop();
  struct stat input,root; struct statfs control;
  if (fstat(0,&input) || !S_ISREG(input.st_mode) || (fcntl(0,F_GETFL)&O_ACCMODE)!=O_RDONLY ||
      lstat(argv[2],&root) || !S_ISDIR(root.st_mode) || root.st_uid!=0 || (root.st_mode&0022) ||
      fstatfs(3,&control) || control.f_type!=CGROUP2_SUPER_MAGIC) stop();
  pid_t parent=getppid();
  if (parent<=1 || prctl(PR_SET_PDEATHSIG,SIGKILL) || getppid()!=parent || prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)) stop();
  limit(RLIMIT_NOFILE,fds); limit(RLIMIT_CORE,0); limit(RLIMIT_FSIZE,0); limit(RLIMIT_RTPRIO,0); limit(RLIMIT_NICE,0);
  struct sched_param ordinary={0}; if (sched_setscheduler(0,SCHED_OTHER,&ordinary)) stop();
  /* "0" moves only this process, before any fork/exec, into the prelimited group. */
  if (write(3,"0",1)!=1 || write(5,"R",1)!=1) stop();
  char gate; ssize_t n; do { n=read(4,&gate,1); } while(n<0 && errno==EINTR);
  if (n!=1 || gate!='G' || getppid()!=parent) stop();
  /* close_range is a host requirement; never leave an unbounded inherited FD. */
  if (syscall(SYS_close_range,3u,~0u,0u)) stop();
  const char *fixed[]={"/usr/bin/bwrap","--unshare-user","--unshare-pid","--unshare-net","--unshare-ipc","--unshare-uts","--unshare-cgroup",
    "--disable-userns","--assert-userns-disabled","--cap-drop","ALL","--die-with-parent","--new-session","--clearenv",
    "--ro-bind",argv[2],"/","--proc","/proc","--remount-ro","/proc","--dev","/dev","--chdir","/",
    "--setenv","PWD","/","--setenv","LANG","C","--setenv","LC_ALL","C","--setenv","PATH","/bin","--",program};
  size_t count=sizeof(fixed)/sizeof(fixed[0]); char *args[300];
  for(size_t i=0;i<count;i++) args[i]=(char*)fixed[i];
  for(int i=4;i<argc;i++) args[count++]=argv[i];
  args[count]=NULL;
  char *env[]={"LANG=C","LC_ALL=C","PATH=/usr/bin",NULL};
  execve("/usr/bin/bwrap",args,env); stop();
}
