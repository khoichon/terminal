/**
 * filesystem.js
 * ---------------------------------------------------------------------------
 * A tiny in-browser virtual filesystem for the khoiios terminal.
 *
 * Storage: localStorage (synchronous, simple, survives page reloads).
 *   - Everything lives under one JSON blob at STORAGE_KEY.
 *   - If you outgrow localStorage's ~5MB quota, swap _persist()/_loadFromDisk()
 *     for IndexedDB calls (see IDB_NOTES at the bottom) — the rest of the
 *     class API stays the same, so callers (terminal commands) don't change.
 *
 * Tree shape:
 *   { type: 'dir',  children: { name: node, ... } }
 *   { type: 'file', content: string, modified: <timestamp> }
 *
 * Paths: unix-style, '/' is root. Supports absolute and relative paths,
 * '.' and '..'.
 * ---------------------------------------------------------------------------
 */

const STORAGE_KEY = 'khoiios_fs_v1';
const CWD_KEY = 'khoiios_cwd_v1';

class VFS {
  constructor() {
    this.root = null;
    this.cwd = ['/', 'home', 'khoii']; // default home, overridden if a saved cwd exists
    this._loadFromDisk();
  }

  /* ---------------------------------------------------------------- disk */

  _loadFromDisk() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      console.warn('localStorage unavailable, using in-memory fs only', e);
    }

    let isFresh = false;
    if (raw) {
      try {
        this.root = JSON.parse(raw);
      } catch (e) {
        console.warn('Corrupt filesystem data, resetting', e);
        this.root = this._freshRoot();
        isFresh = true;
      }
    } else {
      this.root = this._freshRoot();
      isFresh = true;
    }

    try {
      const savedCwd = localStorage.getItem(CWD_KEY);
      if (savedCwd) this.cwd = JSON.parse(savedCwd);
    } catch (e) {
      /* ignore, keep default cwd */
    }

    // First run: persist the freshly-built tree (with the usual root
    // folders + home/khoii) and the default cwd right away.
    if (isFresh) this._persist();
  }

  _freshRoot() {
    // The usual top-level unix-y folders, so `ls /` looks familiar.
    const topLevelDirs = [
      'bin', 'boot', 'dev', 'etc', 'home', 'lib',
      'media', 'mnt', 'opt', 'proc', 'root', 'run',
      'sbin', 'srv', 'tmp', 'usr', 'var',
    ];

    const children = {};
    for (const name of topLevelDirs) {
      children[name] = { type: 'dir', children: {} };
    }

    // Default user's home directory.
    children.home.children.khoii = { type: 'dir', children: {} };

    return { type: 'dir', children };
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.root));
      localStorage.setItem(CWD_KEY, JSON.stringify(this.cwd));
    } catch (e) {
      console.warn('Failed to persist filesystem to localStorage', e);
    }
  }

  /* ------------------------------------------------------------- paths */

  // Turn any path (absolute or relative) into an array of segments from root.
  resolve(path) {
    if (!path || path === '.') path = '';
    const isAbsolute = path.startsWith('/');
    const base = isAbsolute ? [] : this.cwd.slice(1); // drop leading '/'
    const parts = path.split('/').filter((p) => p.length > 0);

    const stack = [...base];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack; // e.g. ['home','user','file.txt']
  }

  pathString(segments) {
    return '/' + segments.join('/');
  }

  pwd() {
    return this.pathString(this.cwd.slice(1));
  }

  /* --------------------------------------------------------------- node */

  // Walk to a node. Returns { node, parent, name } or null if not found.
  _walk(segments) {
    let node = this.root;
    let parent = null;
    let name = '';

    for (const seg of segments) {
      if (!node || node.type !== 'dir') return null;
      parent = node;
      name = seg;
      node = node.children[seg];
      if (!node) return null;
    }
    return { node, parent, name };
  }

  getNode(path) {
    const segments = this.resolve(path);
    if (segments.length === 0) return this.root;
    const result = this._walk(segments);
    return result ? result.node : null;
  }

  exists(path) {
    return this.getNode(path) !== null;
  }

  isDir(path) {
    const n = this.getNode(path);
    return !!n && n.type === 'dir';
  }

  isFile(path) {
    const n = this.getNode(path);
    return !!n && n.type === 'file';
  }

  /* ------------------------------------------------------------ actions */

  cd(path) {
    const segments = this.resolve(path);
    if (segments.length === 0) {
      this.cwd = ['/'];
      this._persist();
      return { ok: true };
    }
    const result = this._walk(segments);
    if (!result) return { ok: false, error: `cd: no such directory: ${path}` };
    if (result.node.type !== 'dir') {
      return { ok: false, error: `cd: not a directory: ${path}` };
    }
    this.cwd = ['/', ...segments];
    this._persist();
    return { ok: true };
  }

  ls(path) {
    const target = path ? this.getNode(path) : this.getNode('.');
    if (!target) return { ok: false, error: `ls: no such file or directory: ${path}` };
    if (target.type === 'file') {
      return { ok: true, entries: [{ name: path, type: 'file' }] };
    }
    const entries = Object.entries(target.children).map(([name, node]) => ({
      name,
      type: node.type,
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, entries };
  }

  mkdir(path, recursive = false) {
    const segments = this.resolve(path);
    if (segments.length === 0) return { ok: false, error: 'mkdir: cannot create root' };

    let node = this.root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      if (!node.children[seg]) {
        if (!isLast && !recursive) {
          return {
            ok: false,
            error: `mkdir: intermediate directory does not exist (use -p): ${segments.slice(0, i + 1).join('/')}`,
          };
        }
        node.children[seg] = { type: 'dir', children: {} };
      } else if (isLast) {
        return { ok: false, error: `mkdir: already exists: ${path}` };
      } else if (node.children[seg].type !== 'dir') {
        return { ok: false, error: `mkdir: not a directory: ${segments.slice(0, i + 1).join('/')}` };
      }
      node = node.children[seg];
    }
    this._persist();
    return { ok: true };
  }

  touch(path) {
    const segments = this.resolve(path);
    if (segments.length === 0) return { ok: false, error: 'touch: invalid path' };

    const parentSegments = segments.slice(0, -1);
    const name = segments[segments.length - 1];
    const parentResult = parentSegments.length === 0
      ? { node: this.root }
      : this._walk(parentSegments);

    if (!parentResult || !parentResult.node || parentResult.node.type !== 'dir') {
      return { ok: false, error: `touch: no such directory: ${this.pathString(parentSegments)}` };
    }

    const parent = parentResult.node;
    if (parent.children[name]) {
      if (parent.children[name].type === 'file') {
        parent.children[name].modified = Date.now();
      }
    } else {
      parent.children[name] = { type: 'file', content: '', modified: Date.now() };
    }
    this._persist();
    return { ok: true };
  }

  readFile(path) {
    const node = this.getNode(path);
    if (!node) return { ok: false, error: `cat: no such file: ${path}` };
    if (node.type !== 'file') return { ok: false, error: `cat: is a directory: ${path}` };
    return { ok: true, content: node.content };
  }

  writeFile(path, content) {
    const segments = this.resolve(path);
    if (segments.length === 0) return { ok: false, error: 'write: invalid path' };

    const parentSegments = segments.slice(0, -1);
    const name = segments[segments.length - 1];
    const parentResult = parentSegments.length === 0
      ? { node: this.root }
      : this._walk(parentSegments);

    if (!parentResult || !parentResult.node || parentResult.node.type !== 'dir') {
      return { ok: false, error: `write: no such directory: ${this.pathString(parentSegments)}` };
    }

    const parent = parentResult.node;
    if (parent.children[name] && parent.children[name].type === 'dir') {
      return { ok: false, error: `write: is a directory: ${path}` };
    }
    parent.children[name] = { type: 'file', content, modified: Date.now() };
    this._persist();
    return { ok: true };
  }

  rm(path, recursive = false) {
    const segments = this.resolve(path);
    if (segments.length === 0) return { ok: false, error: 'rm: cannot remove root' };

    const result = this._walk(segments);
    if (!result) return { ok: false, error: `rm: no such file or directory: ${path}` };

    if (result.node.type === 'dir' && Object.keys(result.node.children).length > 0 && !recursive) {
      return { ok: false, error: `rm: directory not empty (use -r): ${path}` };
    }

    delete result.parent.children[result.name];
    this._persist();
    return { ok: true };
  }

  cp(src, dest, recursive = false) {
    const srcNode = this.getNode(src);
    if (!srcNode) return { ok: false, error: `cp: no such file or directory: ${src}` };
    if (srcNode.type === 'dir' && !recursive) {
      return { ok: false, error: `cp: -r not specified; omitting directory: ${src}` };
    }

    let destSegments = this.resolve(dest);
    // If dest is an existing directory, copy INTO it using src's basename.
    const destNode = this.getNode(dest);
    if (destNode && destNode.type === 'dir') {
      const srcSegments = this.resolve(src);
      const baseName = srcSegments[srcSegments.length - 1];
      destSegments = [...destSegments, baseName];
    }

    const cloned = JSON.parse(JSON.stringify(srcNode));
    const writeResult = this._writeNode(destSegments, cloned);
    if (!writeResult.ok) return writeResult;
    this._persist();
    return { ok: true };
  }

  mv(src, dest) {
    const srcSegments = this.resolve(src);
    const srcResult = this._walk(srcSegments);
    if (!srcResult) return { ok: false, error: `mv: no such file or directory: ${src}` };

    let destSegments = this.resolve(dest);
    const destNode = this.getNode(dest);
    if (destNode && destNode.type === 'dir') {
      const baseName = srcSegments[srcSegments.length - 1];
      destSegments = [...destSegments, baseName];
    }

    const writeResult = this._writeNode(destSegments, srcResult.node);
    if (!writeResult.ok) return writeResult;

    delete srcResult.parent.children[srcResult.name];
    this._persist();
    return { ok: true };
  }

  // Internal helper: place `node` at `segments`, creating the leaf entry
  // (parent directory must already exist).
  _writeNode(segments, node) {
    if (segments.length === 0) return { ok: false, error: 'invalid destination path' };
    const parentSegments = segments.slice(0, -1);
    const name = segments[segments.length - 1];
    const parentResult = parentSegments.length === 0
      ? { node: this.root }
      : this._walk(parentSegments);

    if (!parentResult || !parentResult.node || parentResult.node.type !== 'dir') {
      return { ok: false, error: `no such directory: ${this.pathString(parentSegments)}` };
    }
    parentResult.node.children[name] = node;
    return { ok: true };
  }

  /* --------------------------------------------------------------- misc */

  reset() {
    this.root = this._freshRoot();
    this.cwd = ['/', 'home', 'khoii'];
    this._persist();
  }
}

// Expose a single shared instance for the terminal to use.
window.vfs = new VFS();

/**
 * IDB_NOTES:
 * To back this with IndexedDB instead of localStorage:
 *   1. Replace _loadFromDisk() with an async init that opens a DB
 *      (indexedDB.open('khoiios', 1)) and reads a single record keyed 'fs'.
 *   2. Replace _persist() with an async put() to that same object store.
 *   3. Every VFS method above is synchronous by design (so terminal command
 *      handlers stay simple); if you go the IndexedDB route, either (a) keep
 *      an in-memory mirror of `root`/`cwd` that you sync to IDB in the
 *      background (fire-and-forget _persist(), same sync API), or (b) make
 *      the whole class async and await each command in the terminal's
 *      processCommand(). Option (a) is a drop-in replacement; option (b)
 *      requires updating processCommand to be async.
 */