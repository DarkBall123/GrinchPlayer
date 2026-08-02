'use strict';
const fs = require('fs');
const path = require('path');
const {app, BrowserWindow, dialog, ipcMain, screen} = require('electron');

const localEnvPath = path.join(__dirname, '.env');
if (!process.env.OPENAI_API_KEY && fs.existsSync(localEnvPath)) {
    process.loadEnvFile(localEnvPath);
}

// Note: Must match `build.appId` in package.json
app.setAppUserModelId('com.Nik.GrinchPlayer');
app.disableHardwareAcceleration();

// Keep settings next to the portable executable on Windows. Development builds
// and non-portable packages use Electron's platform default userData directory.
if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
    const userDataPath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, app.getName());
    try {
        fs.mkdirSync(userDataPath, {recursive: true});
        fs.accessSync(userDataPath, fs.constants.W_OK);
        app.setPath('userData', userDataPath);
    } catch (error) {
        console.warn('Portable settings directory is not writable; using the Windows default.', error);
    }
}

const Store = require('electron-store');
Store.initRenderer();
const config = require('./config');
const {AiService} = require('./ai-service');
const aiService = new AiService({Store: Store});
aiService.register(ipcMain);

// Prevent variables from being garbage collected
let mainWindow;
const bounds = config.get('bounds') || {};
const closeReady = new WeakSet();
const closeTimers = new WeakMap();

function getWindow(event) {
    return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle('dialog:open', function (event, options) {
    return dialog.showOpenDialog(getWindow(event), options);
});

ipcMain.handle('dialog:save', function (event, options) {
    return dialog.showSaveDialog(getWindow(event), options);
});

ipcMain.on('dialog:message-sync', function (event, options) {
    event.returnValue = dialog.showMessageBoxSync(getWindow(event), options);
});

ipcMain.on('app:get-path', function (event, name) {
    event.returnValue = name === 'app' ? app.getAppPath() : app.getPath(name);
});

ipcMain.on('window:minimize', function (event) {
    getWindow(event).minimize();
});

ipcMain.on('window:toggle-maximize', function (event) {
    const win = getWindow(event);
    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
});

ipcMain.on('window:close', function (event) {
    getWindow(event).close();
});

ipcMain.on('window:close-ready', function (event) {
    const win = getWindow(event);
    const timer = closeTimers.get(win);
    if (timer) {
        clearTimeout(timer);
        closeTimers.delete(win);
    }
    closeReady.add(win);
    win.close();
});

function boundsAreVisible(savedBounds) {
    if (!Number.isFinite(savedBounds.x) || !Number.isFinite(savedBounds.y) ||
        !Number.isFinite(savedBounds.width) || !Number.isFinite(savedBounds.height)) {
        return false;
    }

    return screen.getAllDisplays().some(function (display) {
        const area = display.workArea;
        return savedBounds.x < area.x + area.width &&
            savedBounds.x + savedBounds.width > area.x &&
            savedBounds.y < area.y + area.height &&
            savedBounds.y + savedBounds.height > area.y;
    });
}

const createMainWindow = async () => {
    const appName = app.getName() + ' v' + app.getVersion();
    const iconPath = path.join(__dirname, 'static/icon-64.png');

    const win = new BrowserWindow({
        title: appName,
        show: false,
        frame: false,
        icon: iconPath,
        width: 1280,
        height: 768,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    if (boundsAreVisible(bounds)) {
        win.setBounds(bounds);
    }

    win.on('ready-to-show', () => {
        win.show();
    });

    win.on('close', (event) => {
        config.set('bounds', win.getBounds());
        if (!closeReady.has(win) && !win.webContents.isDestroyed()) {
            event.preventDefault();
            if (!closeTimers.has(win)) {
                win.webContents.send('window:prepare-close');
                closeTimers.set(win, setTimeout(function () {
                    closeTimers.delete(win);
                    closeReady.add(win);
                    win.close();
                }, 12000));
            }
        }
    });

    win.on('closed', () => {
        // Dereference the window
        // For multiple windows store them in an array
        mainWindow = undefined;
    });

    await win.loadFile(path.join(__dirname, 'index.html'));

    return win;
};

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    aiService.dispose();
});

app.on('activate', async () => {
    if (!mainWindow) {
        mainWindow = await createMainWindow();
    }
});

(async () => {
    await app.whenReady();
    mainWindow = await createMainWindow();
})();
