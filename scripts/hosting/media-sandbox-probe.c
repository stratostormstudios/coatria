/* Original bounded adversarial fixture. Never shipped in the production profile. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <net/route.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void nap(long millis) { struct timespec t={millis/1000,(millis%1000)*1000000}; while(nanosleep(&t,&t)&&errno==EINTR){} }
static int absent(const char *path) { int fd=open(path,O_RDONLY|O_CLOEXEC); if(fd<0)return 1; close(fd);return 0; }
static int write_denied(const char *path) { int fd=open(path,O_WRONLY|O_CREAT|O_CLOEXEC,0600);if(fd<0)return 1;close(fd);return 0; }
static int connection_denied(int family,const char *address,int port) {
 int fd=socket(family,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);if(fd<0)return 1;int result;
 if(family==AF_INET){struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons((uint16_t)port)};inet_pton(AF_INET,address,&a.sin_addr);result=connect(fd,(struct sockaddr*)&a,sizeof(a));}
 else{struct sockaddr_in6 a={.sin6_family=AF_INET6,.sin6_port=htons((uint16_t)port)};inet_pton(AF_INET6,address,&a.sin6_addr);result=connect(fd,(struct sockaddr*)&a,sizeof(a));}
 if(result==0){close(fd);return 0;}
 if(errno==EINPROGRESS){struct pollfd p={.fd=fd,.events=POLLOUT};if(poll(&p,1,200)>0){int error=0;socklen_t length=sizeof(error);if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&length)==0&&error==0){close(fd);return 0;}}}
 close(fd);return 1;
}
static void namespace_id(const char *name,char *output,size_t bytes){char path[80];snprintf(path,sizeof(path),"/proc/self/ns/%s",name);ssize_t length=readlink(path,output,bytes-1);if(length<0)exit(43);output[length]=0;}
static long long nanoseconds(clockid_t id){struct timespec t;if(clock_gettime(id,&t))exit(44);return (long long)t.tv_sec*1000000000LL+t.tv_nsec;}
static int enforced_bwrap_stack(char *label){
 size_t size=strlen(label);while(size&&(label[size-1]=='\n'||label[size-1]=='\r'))label[--size]=0;
 char *mode=strstr(label," (enforce)");if(!mode||strcmp(mode," (enforce)"))return 0;*mode=0;
 char *split=strstr(label,"//&");if(!split||strstr(split+3,"//&"))return 0;*split=0;
 return (!strcmp(label,"bwrap")&&!strcmp(split+3,"unpriv_bwrap"))||(!strcmp(label,"unpriv_bwrap")&&!strcmp(split+3,"bwrap"));
}
static int only_loopback(void){struct if_nameindex *all=if_nameindex();if(!all)return 0;int count=0,valid=1;for(struct if_nameindex *p=all;p->if_index;p++){count++;if(strcmp(p->if_name,"lo"))valid=0;}if_freenameindex(all);return valid&&count==1;}
static int no_routable_default(void){
 FILE *file=fopen("/proc/net/route","r");if(!file)return 0;char line[512],name[16];unsigned long dest,gateway,flags;int valid=1;
 while(fgets(line,sizeof(line),file)){
  if(sscanf(line,"%15s %lx %lx %lx",name,&dest,&gateway,&flags)==4&&
     (strcmp(name,"lo")||(!dest&&(flags&RTF_UP)&&!(flags&RTF_REJECT))))valid=0;
 }
 fclose(file);
 file=fopen("/proc/net/ipv6_route","r");if(!file)return 0;
 while(fgets(line,sizeof(line),file)){char *items[10],*save=NULL,*part=strtok_r(line," \t\n",&save);int count=0;while(part&&count<10){items[count++]=part;part=strtok_r(NULL," \t\n",&save);}if(count!=10){valid=0;continue;}if(strcmp(items[9],"lo")||(!strcmp(items[0],"00000000000000000000000000000000")&&strtoul(items[1],NULL,16)==0&&!(strtoul(items[8],NULL,16)&RTF_REJECT)))valid=0;}fclose(file);return valid;
}

int main(int argc,char **argv){
 if(argc<2)return 40;
 if(!strcmp(argv[1],"label-check")){
  const char *cases[]={"bwrap//&unpriv_bwrap (enforce)\n","unpriv_bwrap//&bwrap (enforce)","unpriv_bwrap (enforce)","bwrap (enforce)","bwrap//&unpriv_bwrap (complain)","unknown//&bwrap//&unpriv_bwrap (enforce)","bwrap//&unpriv_bwrap_extra (enforce)","bwrap//&unpriv_bwrap (enforce) garbage"};
  for(size_t i=0;i<sizeof(cases)/sizeof(cases[0]);i++){char label[512];snprintf(label,sizeof(label),"%s",cases[i]);if(enforced_bwrap_stack(label)!=(i<2))return 42;}
  puts("label parser ok");return 0;
 }
 if(!strcmp(argv[1],"boundary")){
  if(argc!=5)return 40;
  char mnt[64],pid[64],net[64],ipc[64],uts[64],user[64],cgroup[64],proc_path[2048];
  namespace_id("mnt",mnt,sizeof(mnt));namespace_id("pid",pid,sizeof(pid));namespace_id("net",net,sizeof(net));namespace_id("ipc",ipc,sizeof(ipc));namespace_id("uts",uts,sizeof(uts));namespace_id("user",user,sizeof(user));namespace_id("cgroup",cgroup,sizeof(cgroup));
  snprintf(proc_path,sizeof(proc_path),"/proc/%s/root%s",argv[3],argv[2]);
  int host_hidden=absent(argv[2]),proc_hidden=absent(proc_path),env_clean=!getenv("COATRIA_SANDBOX_CANARY")&&!getenv("DATABASE_URL")&&!getenv("COATRIA_HOSTING_KEYRING")&&!getenv("NODE_OPTIONS");
  int extra_closed=1;for(int fd=3;fd<1024;fd++){if(fcntl(fd,F_GETFD)>=0||errno!=EBADF){extra_closed=0;break;}}
  struct stat info;int readonly=fstat(0,&info)==0&&S_ISREG(info.st_mode)&&(fcntl(0,F_GETFL)&O_ACCMODE)==O_RDONLY;errno=0;readonly=readonly&&write(0,"X",1)<0&&errno==EBADF;
  struct statvfs root_mount;
  int root_readonly=statvfs("/",&root_mount)==0&&(root_mount.f_flag&ST_RDONLY)&&write_denied("/forbidden-write")&&write_denied("/bin/ffprobe");
  FILE *status=fopen("/proc/self/status","r");char *line=NULL;size_t capacity=0;unsigned long long caps=1;int nnp=0;
  if(!status)return 41;
  while(getline(&line,&capacity,status)>=0){if(!strncmp(line,"CapEff:",7))sscanf(line+7,"%llx",&caps);if(!strncmp(line,"NoNewPrivs:",11))sscanf(line+11,"%d",&nnp);}free(line);fclose(status);
  int nested_denied=unshare(CLONE_NEWUSER)<0;
  FILE *attr=fopen("/proc/self/attr/current","r");char label[512]={0};int apparmor_stacked=0;
  if(attr){if(fgets(label,sizeof(label),attr)&&strlen(label)<sizeof(label)-1&&fgetc(attr)==EOF)apparmor_stacked=enforced_bwrap_stack(label);fclose(attr);}
  int port=atoi(argv[4]);if(port<1||port>65535)return 40;
  int local_denied=connection_denied(AF_INET,"127.0.0.1",port),external_denied=connection_denied(AF_INET,"192.0.2.1",443),ipv6_denied=connection_denied(AF_INET6,"2001:db8::1",443);
  int interfaces=only_loopback(),routes=no_routable_default();
  printf("{\"interfacesLoopbackOnly\":%s,\"routableDefaultAbsent\":%s,\"apparmorChildStacked\":%s}\n",interfaces?"true":"false",routes?"true":"false",apparmor_stacked?"true":"false");
  printf("{\"hostFileHidden\":%s,\"hostProcHidden\":%s,\"environmentClean\":%s,\"extraHandlesClosed\":%s,\"inputReadonly\":%s,\"rootReadonly\":%s,\"capabilitiesZero\":%s,\"noNewPrivileges\":%s,\"nestedUsernsDenied\":%s,\"localNetworkDenied\":%s,\"externalNetworkDenied\":%s,\"ipv6Denied\":%s,\"namespaces\":{\"mnt\":\"%s\",\"pid\":\"%s\",\"net\":\"%s\",\"ipc\":\"%s\",\"uts\":\"%s\",\"user\":\"%s\",\"cgroup\":\"%s\"}}\n",host_hidden?"true":"false",proc_hidden?"true":"false",env_clean?"true":"false",extra_closed?"true":"false",readonly?"true":"false",root_readonly?"true":"false",caps==0?"true":"false",nnp==1?"true":"false",nested_denied?"true":"false",local_denied?"true":"false",external_denied?"true":"false",ipv6_denied?"true":"false",mnt,pid,net,ipc,uts,user,cgroup);fflush(stdout);nap(300);
  return host_hidden&&proc_hidden&&env_clean&&extra_closed&&readonly&&root_readonly&&caps==0&&nnp==1&&nested_denied&&local_denied&&external_denied&&ipv6_denied&&interfaces&&routes&&apparmor_stacked?0:42;
 }
 if(!strcmp(argv[1],"files")){
  int count=0,fd;while(count<1024&&(fd=open("/dev/null",O_RDONLY|O_CLOEXEC))>=0)count++;int limited=errno==EMFILE;printf("{\"openFiles\":%d,\"limited\":%s}\n",count,limited?"true":"false");return limited?0:42;
 }
 if(!strcmp(argv[1],"pids")||!strcmp(argv[1],"orphan")||!strcmp(argv[1],"timeout")){
  int target=!strcmp(argv[1],"pids")?128:3,count=0,limited=0;
  for(int i=0;i<target;i++){pid_t child=fork();if(child<0){limited=errno==EAGAIN;break;}if(child==0){signal(SIGTERM,SIG_IGN);setsid();nap(30000);_exit(0);}count++;}
  printf("{\"forked\":%d,\"limited\":%s}\n",count,limited?"true":"false");fflush(stdout);
  if(!strcmp(argv[1],"timeout")){signal(SIGTERM,SIG_IGN);nap(30000);}else nap(300);
  return !strcmp(argv[1],"pids")&&!limited?42:0;
 }
 if(!strcmp(argv[1],"memory")){
  int gate[2];if(pipe(gate))return 45;
  for(int i=0;i<3;i++){
   pid_t child=fork();if(child<0)return 45;
   if(child==0){close(gate[1]);char start;if(read(gate[0],&start,1)!=1)_exit(45);close(gate[0]);
    volatile unsigned char *held=malloc(32*1024*1024);if(!held)_exit(45);
    for(size_t n=0;n<32*1024*1024;n+=4096)held[n]=(unsigned char)(i+1);
    nap(30000);_exit(42);
   }
  }
  close(gate[0]);nap(300);if(write(gate[1],"GGG",3)!=3)return 45;close(gate[1]);
  // Each child holds less than 64 MiB; the combined 96 MiB must trigger the
  // cgroup's 64 MiB aggregate bound and oom.group must kill this parent too.
  nap(30000);return 42;
 }
 if(!strcmp(argv[1],"cpu")){
  int gate[2];pid_t children[2];if(pipe(gate))return 45;
  for(int child=0;child<2;child++){
   children[child]=fork();if(children[child]<0)return 45;
   if(children[child]==0){close(gate[1]);char start;if(read(gate[0],&start,1)!=1)_exit(45);close(gate[0]);
    long long cpu=nanoseconds(CLOCK_PROCESS_CPUTIME_ID);volatile uint64_t counter=1;
    while(nanoseconds(CLOCK_PROCESS_CPUTIME_ID)-cpu<250000000LL){for(int i=0;i<10000;i++)counter=counter*1664525+1013904223;}
    _exit(0);
   }
  }
  close(gate[0]);long long wall=nanoseconds(CLOCK_MONOTONIC),cpu=0;if(write(gate[1],"GG",2)!=2)return 45;close(gate[1]);
  for(int i=0;i<2;i++){int status;struct rusage usage;if(wait4(children[i],&status,0,&usage)<0||!WIFEXITED(status)||WEXITSTATUS(status))return 45;cpu+=((long long)usage.ru_utime.tv_sec+usage.ru_stime.tv_sec)*1000000000LL+((long long)usage.ru_utime.tv_usec+usage.ru_stime.tv_usec)*1000;}
  printf("{\"cpuNs\":%lld,\"wallNs\":%lld,\"children\":2}\n",cpu,nanoseconds(CLOCK_MONOTONIC)-wall);return 0;
 }
 if(!strcmp(argv[1],"-version")){puts("coatria-original-conformance-probe 1");return 0;}
 if(argc==4&&!strcmp(argv[1],"-hide_banner")&&!strcmp(argv[2],"-h")&&!strcmp(argv[3],"protocol=fd")){puts("fd AVOptions:");return 0;}
 return 40;
}
