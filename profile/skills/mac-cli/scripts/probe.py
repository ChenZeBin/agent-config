#!/usr/bin/env python3
"""Bounded mac-cli compatibility audit; system reads and disposable fixtures only."""
import argparse, datetime, hashlib, json, os, pathlib, platform, re, shutil, signal, subprocess, tarfile, tempfile, time, zipfile
PIN = "26c047242351e4b1c66bff91548a07352a694f16"
FILES = ["mac", "mac-cli/misc/help"] + ["mac-cli/plugins/" + n for n in ["general","network","brew","search","ssh","performance","dns","volume","git"]]
ANSI = re.compile(r"\x1b\[[0-9;]*m")
def digest(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def network_quality_ok(result):
    output=ANSI.sub("",result["stdout"]+result["stderr"])
    if result["exit_code"]!=0 or result["timed_out"]:
        return False
    if re.search(r"(?im)^\s*Error:|Expected HTTP status|NetworkQualityErrorDomain|Total Network Errors:\s*[1-9][0-9]*",output):
        return False
    for direction in ("Uplink","Downlink"):
        values=re.findall(direction+r" capacity:\s*([0-9.]+)\s*[kMGT]?bps",output)
        if not values or any(float(value)<=0 for value in values):
            return False
    return True
def run(argv, cwd=None, stdin="", timeout=12, env=None):
    start=time.monotonic()
    p=subprocess.Popen(argv,cwd=cwd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,errors="replace",env=env,start_new_session=True)
    timed=False
    try: out,err=p.communicate(stdin,timeout=timeout)
    except subprocess.TimeoutExpired:
        timed=True
        os.killpg(p.pid,signal.SIGTERM)
        try: out,err=p.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate()
    return {"argv":argv,"exit_code":p.returncode,"timed_out":timed,"seconds":round(time.monotonic()-start,3),"stdout":out,"stderr":err}
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--mac",default=shutil.which("mac"))
    ap.add_argument("--output",type=pathlib.Path,required=True,help="Private local JSON report; do not publish raw output")
    ap.add_argument("--network",action="store_true",help="Also run public IP and networkQuality (uses bandwidth)")
    a=ap.parse_args()
    if a.output.exists() or a.output.is_symlink(): raise SystemExit("Report already exists; choose a new local path.")
    if platform.system()!="Darwin": raise SystemExit("This probe requires macOS.")
    if not a.mac: raise SystemExit("mac not found; do not install a same-name tool automatically.")
    mac=pathlib.Path(a.mac).absolute()
    installed={n:digest(mac.parent/n) for n in FILES if (mac.parent/n).is_file()}
    installed["mac"]=digest(mac)
    manifest=pathlib.Path(__file__).resolve().parents[1]/"references/source-manifest.json"
    expected=json.loads(manifest.read_text())["sha256"]
    if installed!=expected: raise SystemExit("Source mismatch or missing plugins: inspect the exact CLI before execution.")
    depnames=["brew","git","pv","wget","networkQuality","osascript","pmset","top","gzip","tar","unzip","lsof","networksetup"]
    report={"started_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"probe_sha256":digest(__file__),"source_revision":PIN,
        "source_sha256":installed,"entry":str(mac),"host":{"macos":run(["sw_vers"])["stdout"],"arch":platform.machine()},
        "dependencies":{n:shutil.which(n) for n in depnames},
        "legacy_paths":{p:os.path.exists(p) for p in [
        "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
        "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession"]},"tests":[]}
    def probe(name,args,check,cwd=None,stdin="",timeout=12,env=None,note=""):
        r=run([str(mac),*args],cwd,stdin,timeout,env)
        output=ANSI.sub("",r["stdout"]+r["stderr"])
        try: passed=bool(check(r,output))
        except (OSError,ValueError,tarfile.TarError): passed=False
        r.update(id=name,status="passed" if passed else "failed",note=note)
        report["tests"].append(r)
    with tempfile.TemporaryDirectory(prefix="mac-cli-probe-") as t:
        base=pathlib.Path(t)
        # No ambient repository or HOME contents are scanned.
        for cmd,pat in [
            ("help","General Utilities:"),("info","ProductVersion:"),("uptime","load averages:"),
            ("battery","AC Power|Battery Power"),("volume",r"Vol:\s*\d+%"),
            ("volume:ismute","Mute:.*(true|false)"),("bluetooth:status","Bluetooth: (ON|OFF)"),
            ("wifi:status",r"SSID:|state:"),("wifi:scan",r"SSID.*BSSID"),
            ("dns:list",r"(?m)^\s*(?:\d{1,3}\.){3}\d{1,3}\s*$"),
            ("ip:local",r"(?m)^(?:\d{1,3}\.){3}\d{1,3}\s*$"),
            ("trash:size",r"(?m)^\s*[\d.]+[BKMGTP]?\s+.*\.Trash/?\s*$")]:
            probe(cmd,[cmd],lambda r,o,p=pat: r["exit_code"]==0 and not r["timed_out"] and bool(re.search(p,o)),base)
        for cmd in ["system","temp","display","hosts:edit","ssh:list","git:settings","git:branches:date","image","magento"]:
            probe(cmd,[cmd],lambda r,o: bool(o.strip()),base,note="Static source inspection: listed command has no handler.")
        probe("memory",["memory"],lambda r,o: "PhysMem:" in o and "PID" in o,base,timeout=4,note="Bounded observation only; top is intentionally terminated if still running.")
        sample=base/"sample";sample.mkdir();(sample/"small.txt").write_text("mac-probe-needle\n")
        (sample/"large.txt").write_text("z"*8192)
        (sample/"space name.txt").write_text("mac-probe-needle\n")
        probe("folder:size",["folder:size"],lambda r,o: bool(re.search(r"(?m)^\s*[\d.]+[BKMGTP]?\s+\.$",o)),sample)
        probe("folders:list",["folders:list"],lambda r,o: "large.txt" in o and "space name.txt" in o,sample)
        probe("find:biggest-files",["find:biggest-files"],lambda r,o: "./large.txt" in o and "./space name.txt" in o,sample)
        probe("find:biggest-directories",["find:biggest-directories"],lambda r,o: bool(re.search(r"(?m)^\s*[\d.]+[BKMGTP]?\s+\.$",o)),sample)
        simple=base/"simple";simple.mkdir();(simple/"input.txt").write_text("mac-probe-needle\n")
        probe("find:text-simple",["find:text","mac-probe-needle"],lambda r,o: bool(re.search(r"(?m)^(?:\./input.txt:)?1:mac-probe-needle$",o)),simple,"txt\n")
        probe("find:text-spaces",["find:text","mac-probe-needle"],lambda r,o: "./space name.txt:1:mac-probe-needle" in o,sample,"txt\n")
        (simple/"replace.txt").write_text("before\n")
        probe("search:replace",["search:replace","replace.txt"],lambda r,o: (simple/"replace.txt").read_text()=="after\n",simple,"before\nafter\n")
        payload=b"mac-cli-fixture\n"
        for label,filename in [("simple","payload.txt"),("spaces","payload space.txt")]:
            f=simple/filename;f.write_bytes(payload)
            probe("gzip:compress-"+label,["gzip:compress",filename],lambda r,o,f=f: not f.exists() and pathlib.Path(str(f)+".gz").is_file(),simple)
            if pathlib.Path(str(f)+".gz").exists():
                probe("gzip:extract-"+label,["gzip:extract",filename+".gz"],lambda r,o,f=f: f.read_bytes()==payload and not pathlib.Path(str(f)+".gz").exists(),simple)
        for label,filename in [("simple","archive.zip"),("spaces","archive space.zip")]:
            folder=base/("zip-"+label);folder.mkdir()
            with zipfile.ZipFile(folder/filename,"w") as z:z.writestr("restored.txt",payload)
            probe("zip:extract-"+label,["zip:extract",filename],lambda r,o,f=folder: (f/"restored.txt").read_bytes()==payload,folder)
        tf=base/"tar";tf.mkdir();(tf/"input.txt").write_bytes(payload)
        def valid_tar(r,o):
            with tarfile.open(tf/"output.tgz","r:gz") as z:return z.extractfile("input.txt").read()==payload
        probe("tar:compress",["tar:compress","input.txt"],valid_tar,tf,"output\n")
        # Extraction is tested independently, even if compression lacks pv.
        ext=base/"tar-extract";ext.mkdir()
        with tarfile.open(ext/"valid.tgz","w:gz") as z:z.add(tf/"input.txt",arcname="input.txt")
        probe("tar:extract",["tar:extract","valid.tgz"],lambda r,o: (ext/"input.txt").read_bytes()==payload,ext)
        repo=base/"repo";repo.mkdir()
        env=os.environ.copy()
        env.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM="1",GIT_TERMINAL_PROMPT="0",GIT_PAGER="cat",
                   GIT_AUTHOR_NAME="Fixture",GIT_AUTHOR_EMAIL="fixture@example.com",GIT_COMMITTER_NAME="Fixture",GIT_COMMITTER_EMAIL="fixture@example.com")
        for argv in [["git","init","-b","main"],["git","config","user.name","Fixture"],["git","config","user.email","fixture@example.com"]]:
            r=run(argv,repo,env=env);assert r["exit_code"]==0,r
        (repo/"remove.txt").write_text("remove fixture\n")
        for i in [1,2]:
            (repo/"data.txt").write_text(str(i))
            assert run(["git","add","data.txt","remove.txt"],repo,env=env)["exit_code"]==0
            # Fixture commits are disposable test data, never delivery commits.
            assert run(["git","-c","core.hooksPath=/dev/null","commit","-m","fixture-"+str(i)],repo,env=env)["exit_code"]==0
        probe("git:config",["git:config"],lambda r,o: "user.name=Fixture" in o,repo,env=env)
        probe("git:log",["git:log"],lambda r,o: "fixture-1" in o and "fixture-2" in o,repo,env=env)
        probe("git:branch",["git:branch"],lambda r,o: "* main" in o,repo,env=env)
        probe("git:create:branch",["git:create:branch","probe"],lambda r,o: run(["git","branch","--show-current"],repo,env=env)["stdout"].strip()=="probe",repo,env=env)
        probe("git:branch:rename",["git:branch:rename","renamed"],lambda r,o: run(["git","branch","--show-current"],repo,env=env)["stdout"].strip()=="renamed",repo,env=env)
        run(["git","checkout","main"],repo,env=env)
        probe("git:branch:remove-local",["git:branch:remove-local","renamed"],lambda r,o: "renamed" not in run(["git","branch"],repo,env=env)["stdout"],repo,env=env)
        before=run(["git","rev-list","--count","HEAD"],repo,env=env)["stdout"]
        probe("git:undo-commit",["git:undo-commit"],lambda r,o: before.strip()=="2" and run(["git","rev-list","--count","HEAD"],repo,env=env)["stdout"].strip()=="1" and (repo/"data.txt").read_text()=="2",repo,env=env)
        assert run(["git","reset"],repo,env=env)["exit_code"]==0
        (repo/"remove.txt").unlink()
        assert run(["git","diff","--cached","--name-only"],repo,env=env)["stdout"]==""
        probe("git:add-removed",["git:add-removed"],lambda r,o: set(run(["git","diff","--cached","--name-only"],repo,env=env)["stdout"].splitlines())=={"data.txt","remove.txt"},repo,env=env,note="Initially empty index; proves git add -u stages both a modified and a deleted tracked file.")
        probe("git:size",["git:size"],lambda r,o: bool(re.search(r"(?m)^[\d.]+[BKMGTP]?\s+tmp.bundle$",o)) and not (repo/"tmp.bundle").exists(),repo,env=env,note="Writes/deletes tmp.bundle; fixture only.")
        if a.network:
            probe("ip:public",["ip:public"],lambda r,o: bool(re.search(r"(?m)^(?:\d{1,3}\.){3}\d{1,3}\s*$",o)),base,timeout=15)
            probe("speedtest",["speedtest"],lambda r,o: network_quality_ok(r),base,timeout=60,note="A zero exit code with HTTP errors or zero capacity is not a successful measurement.")
    report["finished_at"]=datetime.datetime.now(datetime.timezone.utc).isoformat()
    a.output.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w") as f:json.dump(report,f,indent=2,ensure_ascii=False);f.write("\n")
    print(json.dumps({"report":str(a.output),"passed":[x["id"] for x in report["tests"] if x["status"]=="passed"],"failed":[x["id"] for x in report["tests"] if x["status"]=="failed"],"dependencies":report["dependencies"],"legacy_paths":report["legacy_paths"]},ensure_ascii=False,indent=2))
if __name__=="__main__":main()

