/**
 * Just enough of WASI (preview 1) to run a command-line program built for it, such as jpegtran (jpegtran.wasm): its
 * arguments, standard input from bytes, and standard output and error into bytes. No files, no clock, no environment:
 * a call for any of those is refused, as a sandbox with nothing in it would. Runs the same in a browser, a worker and
 * Bun (tested there).
 */

const ESUCCESS = 0;
const EBADF = 8;
const ESPIPE = 70;
const ENOTCAPABLE = 76;
/** A character device: what standard input and output are. */
const CHARACTER_DEVICE = 2;

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Ran {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** Run `module`'s `_start` with these arguments (the program's name first) and this as its standard input. */
export function runWasi(module: WebAssembly.Module, args: string[], stdin: Uint8Array): Ran {
  let memory!: WebAssembly.Memory;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const enc = new TextEncoder();
  const argv = args.map((a) => enc.encode(`${a}\0`));
  let read = 0;
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const iovecs = (ptr: number, n: number) => Array.from({ length: n }, (_, i) => [view().getUint32(ptr + i * 8, true), view().getUint32(ptr + i * 8 + 4, true)] as const);

  const wasi = {
    args_sizes_get(argc: number, size: number) {
      view().setUint32(argc, argv.length, true);
      view().setUint32(size, argv.reduce((n, a) => n + a.length, 0), true);
      return ESUCCESS;
    },
    args_get(ptrs: number, buf: number) {
      for (const a of argv) {
        view().setUint32(ptrs, buf, true);
        bytes().set(a, buf);
        ptrs += 4;
        buf += a.length;
      }
      return ESUCCESS;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return ESUCCESS;
    },
    environ_get: () => ESUCCESS,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    path_open: () => ENOTCAPABLE,
    fd_fdstat_get(fd: number, ptr: number) {
      if (fd > 2) return EBADF;
      const v = view();
      v.setUint8(ptr, CHARACTER_DEVICE);
      v.setUint16(ptr + 2, 0, true);
      v.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
      v.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
      return ESUCCESS;
    },
    fd_fdstat_set_flags: () => ESUCCESS,
    fd_seek: () => ESPIPE,
    fd_close: () => ESUCCESS,
    fd_read(fd: number, iovs: number, n: number, nread: number) {
      if (fd !== 0) return EBADF;
      let got = 0;
      for (const [buf, len] of iovecs(iovs, n)) {
        const take = Math.min(len, stdin.length - read);
        bytes().set(stdin.subarray(read, read + take), buf);
        read += take;
        got += take;
        if (take < len) break;
      }
      view().setUint32(nread, got, true);
      return ESUCCESS;
    },
    fd_write(fd: number, iovs: number, n: number, nwritten: number) {
      if (fd !== 1 && fd !== 2) return EBADF;
      let put = 0;
      for (const [buf, len] of iovecs(iovs, n)) {
        (fd === 1 ? out : err).push(bytes().slice(buf, buf + len));
        put += len;
      }
      view().setUint32(nwritten, put, true);
      return ESUCCESS;
    },
    proc_exit(code: number) {
      throw new Exit(code);
    },
  };

  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi });
  memory = instance.exports.memory as WebAssembly.Memory;
  let code = 0;
  try {
    (instance.exports._start as () => void)();
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  }
  const join = (parts: Uint8Array[]) => {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) all.set(p, (at += p.length) - p.length);
    return all;
  };
  return { code, stdout: join(out), stderr: new TextDecoder().decode(join(err)) };
}
