# GrinchPlayer

> Технопранк-плеер для троллинга звуками

[![Видеогайд по плееру](https://img.youtube.com/vi/Tqy9zhD82Ik/maxresdefault.jpg)](https://www.youtube.com/watch?v=Tqy9zhD82Ik)
## Install

*Основная целевая платформа: Windows 10/11 (64-bit). Разработка возможна на macOS.*

**Windows**

[**Download**](https://github.com/n3tman/GrinchPlayer/releases/latest) the `.exe` file.

---

## Dev

Built with [Electron](https://electronjs.org).

Requires Node.js 22 or newer.

### Run

```
$ npm ci
$ npm start
```

### Build for Windows 10/11

```
$ npm run win
```

The portable x64 `.exe` is created in `dist/`. GitHub Actions runs the same build on Windows for every push and pull request.
