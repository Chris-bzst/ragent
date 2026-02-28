class WebClaudeCode {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.socket = null;
        this.statusEl = document.getElementById('status');
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 999;
        this.activeWindowIndex = 0;
        this.pingInterval = null;
        this.isUploadingImage = false;
        this.toastTimer = null;
        this._pasteOverlayTimer = null;
        this._pasteSent = false;
        this._reconnectTimer = null;

        this.init();
    }

    getResponsiveFontSize() {
        const width = window.innerWidth;
        if (width <= 320) return 10;
        if (width <= 375) return 11;
        if (width <= 480) return 12;
        if (width <= 768) return 13;
        return 14;
    }

    init() {
        this.setupTerminal();
        this.connect();
        this.setupEventListeners();
        this.setupVirtualKeys();
        this.setupSelectionOverlay();
        this.setupPasteOverlay();
        this.setupImagePaste();
    }

    setupTerminal() {
        this.terminal = new Terminal({
            cursorBlink: false,
            cursorStyle: 'bar',
            cursorInactiveStyle: 'none',
            allowProposedApi: true,
            scrollback: 5000,
            theme: {
                background: '#1e1e1e',
                foreground: '#cccccc',
                cursor: 'transparent',
                black: '#000000',
                red: '#f44747',
                green: '#4ec9b0',
                yellow: '#ffcc02',
                blue: '#569cd6',
                magenta: '#c586c0',
                cyan: '#4fc1ff',
                white: '#cccccc'
            },
            fontSize: this.getResponsiveFontSize(),
            fontFamily: '"Cascadia Code", "Fira Code", "Courier New", "Menlo", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", monospace'
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.terminal.loadAddon(this.fitAddon);

        try {
            if (typeof Unicode11Addon !== 'undefined') {
                const unicode11Addon = new Unicode11Addon.Unicode11Addon();
                this.terminal.loadAddon(unicode11Addon);
                this.terminal.unicode.activeVersion = '11';
            }
        } catch (e) {
            console.warn('Failed to load Unicode11Addon:', e);
        }

        const terminalEl = document.getElementById('terminal');
        this.terminal.open(terminalEl);
        this.fitAddon.fit();

        this.setupTouchScroll(terminalEl);

        this.terminal.attachCustomKeyEventHandler((e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && e.type === 'keydown') {
                if (this.terminal.hasSelection()) {
                    const selection = this.terminal.getSelection();
                    if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(selection).catch(() => {
                            this.fallbackCopy(selection);
                        });
                    } else {
                        this.fallbackCopy(selection);
                    }
                    return false;
                }
            }
            // Handle Ctrl+V / Cmd+V: use clipboard API directly so paste
            // keeps working even after xterm.js's internal textarea loses
            // clipboard permission (which causes the "works then stops" bug).
            if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && e.type === 'keydown') {
                if (navigator.clipboard && window.isSecureContext) {
                    e.preventDefault(); // prevent browser's default paste to avoid double-send
                    navigator.clipboard.readText().then((text) => {
                        if (text && this.socket && this.socket.readyState === WebSocket.OPEN) {
                            this.socket.send(JSON.stringify({ type: 'input', data: text }));
                        }
                    }).catch(() => {});
                    return false;
                }
                // No clipboard API — let xterm.js handle paste natively
                return true;
            }
            return true;
        });

        this.terminal.onData((data) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'input', data }));
            } else if (data.length > 1) {
                // Multi-char input is likely a paste; notify user it was lost.
                // Single chars (keystrokes) are not worth alerting on.
                this.showToast('Not connected');
            }
        });

        this.terminal.onResize((size) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'resize', data: { cols: size.cols, rows: size.rows } }));
            }
        });
    }

    reconnectNow() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        this.connect();
    }

    connect() {
        // Clean up old socket to prevent duplicate onclose triggers
        if (this.socket) {
            this.socket.onclose = null;
            this.socket.onerror = null;
            try { this.socket.close(); } catch (_) {}
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;

        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
            this.updateStatus('Connected', '#4ec9b0');
            if (this.reconnectAttempts > 0) {
                this.terminal.reset();
            }
            this.reconnectAttempts = 0;

            this.stopHeartbeat();
            this.pingInterval = setInterval(() => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);

            setTimeout(() => {
                this.terminal.focus();
                this.fitAddon.fit();
                const dims = this.fitAddon.proposeDimensions();
                if (dims && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'resize', data: { cols: dims.cols, rows: dims.rows } }));
                }
            }, 50);
        };

        this.socket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                switch (message.type) {
                    case 'data':
                        this.terminal.write(message.data);
                        break;
                    case 'pong':
                        break;
                    case 'exit':
                        this.terminal.writeln(`\r\n\x1b[31mProcess exited with code ${message.exitCode}\x1b[0m`);
                        this.updateStatus('Disconnected', '#f44747');
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        };

        this.socket.onclose = () => {
            this.stopHeartbeat();
            this.updateStatus('Disconnected', '#f44747');
            this.terminal.writeln('\r\n\x1b[31mConnection closed.\x1b[0m');
            this.attemptReconnect();
        };

        this.socket.onerror = (error) => {
            this.stopHeartbeat();
            console.error('WebSocket error:', error);
            this.updateStatus('Error', '#f44747');
        };
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

            if (this.reconnectAttempts > 20) {
                this.updateStatus('Connection keeps failing, try refreshing', '#f44747');
            } else {
                this.updateStatus(`Reconnecting... (${this.reconnectAttempts})`, '#ffcc02');
            }
            this.terminal.writeln(`\x1b[33mReconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...\x1b[0m`);

            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this.connect();
            }, delay);
        } else {
            this.updateStatus('Connection failed', '#f44747');
            this.terminal.writeln('\r\n\x1b[31mConnection failed. Please refresh the page.\x1b[0m');
        }
    }

    stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    setupTouchScroll(terminalEl) {
        const lineHeight = this.terminal.options.lineHeight || 1;
        const fontSize = this.terminal.options.fontSize || 14;
        const rowPx = fontSize * lineHeight;

        let touchStartY = 0;
        let touchClientX = 0;
        let touchClientY = 0;
        let accumulated = 0;
        let isTouchScrolling = false;

        terminalEl.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                touchStartY = e.touches[0].clientY;
                touchClientX = e.touches[0].clientX;
                touchClientY = e.touches[0].clientY;
                accumulated = 0;
                isTouchScrolling = false;
            }
        }, { passive: true });

        terminalEl.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            const currentY = e.touches[0].clientY;
            const deltaY = touchStartY - currentY;

            if (!isTouchScrolling && Math.abs(deltaY) > 5) {
                isTouchScrolling = true;
            }

            if (isTouchScrolling) {
                accumulated += deltaY;
                touchStartY = currentY;
                const lines = Math.trunc(accumulated / rowPx);
                if (lines !== 0) {
                    const screenEl = terminalEl.querySelector('.xterm-screen');
                    if (screenEl && this.socket && this.socket.readyState === WebSocket.OPEN) {
                        const rect = screenEl.getBoundingClientRect();
                        const cellWidth = rect.width / this.terminal.cols;
                        const cellHeight = rect.height / this.terminal.rows;
                        const col = Math.max(1, Math.min(this.terminal.cols,
                            Math.floor((touchClientX - rect.left) / cellWidth) + 1));
                        const row = Math.max(1, Math.min(this.terminal.rows,
                            Math.floor((touchClientY - rect.top) / cellHeight) + 1));
                        // SGR mouse protocol: button 64 = scroll up, 65 = scroll down
                        // lines > 0 means finger swiped up (positive deltaY) → wheel down (button 65)
                        // This matches the original WheelEvent behavior (positive deltaY = scroll down)
                        const btn = lines > 0 ? 65 : 64;
                        const seq = `\x1b[<${btn};${col};${row}M`;
                        this.socket.send(JSON.stringify({
                            type: 'input',
                            data: seq.repeat(Math.abs(lines))
                        }));
                    }
                    accumulated -= lines * rowPx;
                }
                e.preventDefault();
            }
        }, { passive: false });
    }

    updateStatus(text, color = '#cccccc') {
        this.statusEl.textContent = text;
        this.statusEl.style.color = color;
    }

    setupEventListeners() {
        let resizeTimeout = null;
        const handleResize = () => {
            if (resizeTimeout) clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.fitAddon && this.terminal) {
                    const newFontSize = this.getResponsiveFontSize();
                    if (this.terminal.options.fontSize !== newFontSize) {
                        this.terminal.options.fontSize = newFontSize;
                        this.fitAddon.fit();
                        return;
                    }
                    this.fitAddon.fit();
                }
            }, 100);
        };

        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', () => setTimeout(handleResize, 200));

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                switch (e.key) {
                    case 'r': case 'w': case 't': case 'l': case 'b': return;
                    case 'c': case 'C':
                        if (this.terminal && this.terminal.hasSelection()) { e.preventDefault(); return; }
                        break;
                    case 'v': case 'V': return;
                    case 'a': case 'A':
                        if (this.terminal) this.terminal.selectAll();
                        e.preventDefault(); return;
                    default: break;
                }
                e.preventDefault();
            }
        });

        document.addEventListener('click', (e) => {
            if (this.terminal && !e.target.closest('[role="dialog"]') && !e.target.closest('.virtual-keys')) {
                if (!this.terminal.hasSelection()) this.terminal.focus();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'r' && this.socket && this.socket.readyState !== WebSocket.OPEN) {
                e.preventDefault();
                this.reconnectNow();
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && (!this.socket || this.socket.readyState !== WebSocket.OPEN)) {
                this.reconnectNow();
            }
        });
    }

    setupVirtualKeys() {
        const virtualKeysContainer = document.getElementById('virtual-keys');
        if (!virtualKeysContainer) return;

        virtualKeysContainer.addEventListener('mousedown', (e) => { e.preventDefault(); });

        virtualKeysContainer.addEventListener('touchstart', (e) => {
            const button = e.target.closest('.vkey');
            if (button) { e.preventDefault(); button.click(); }
        }, { passive: false });

        virtualKeysContainer.addEventListener('click', (e) => {
            const button = e.target.closest('.vkey');
            if (!button || (button.parentElement?.classList.contains('vkey-menu-wrapper'))) return;

            e.preventDefault();
            let keyData = '';

            if (button.dataset.ctrl) {
                const char = button.dataset.ctrl.toLowerCase();
                keyData = String.fromCharCode(char.charCodeAt(0) - 96);
            } else if (button.dataset.action === 'select') {
                this.openSelectionOverlay();
                return;
            } else if (button.dataset.action === 'paste') {
                this.openPasteOverlay();
                return;
            } else if (button.dataset.key) {
                switch (button.dataset.key) {
                    case 'Escape': keyData = '\x1b'; break;
                    case 'Tab': keyData = '\t'; break;
                    case 'ShiftTab': keyData = '\x1b[Z'; break;
                    case 'Enter': keyData = '\r'; break;
                    case 'ArrowUp': keyData = '\x1b[A'; break;
                    case 'ArrowDown': keyData = '\x1b[B'; break;
                    case 'ArrowRight': keyData = '\x1b[C'; break;
                    case 'ArrowLeft': keyData = '\x1b[D'; break;
                }
            }

            if (keyData && this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'input', data: keyData }));
            }
        });

        this.setupWindowMenu();
        this.setupArrowMenu();
        this.setupSimpleMenu('tab-menu-btn', 'tab-menu');
        this.setupSimpleMenu('edit-menu-btn', 'edit-menu');
    }

    setupWindowMenu() {
        const menuBtn = document.getElementById('window-menu-btn');
        const menu = document.getElementById('window-menu');
        if (!menuBtn || !menu) return;

        menuBtn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const isOpen = menu.classList.contains('open');
            if (isOpen) {
                menu.classList.remove('open');
            } else {
                this.closeAllMenus();
                await this.fetchWindows();
                await this.fetchPanes();
                menu.classList.add('open');
                const btnRect = menuBtn.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                const menuLeft = btnRect.left + (btnRect.width / 2) - (menuRect.width / 2);
                const clampedLeft = Math.max(8, Math.min(menuLeft, window.innerWidth - menuRect.width - 8));
                menu.style.left = clampedLeft + 'px';
                menu.style.bottom = (window.innerHeight - btnRect.top + 8) + 'px';
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.vkey-menu-wrapper')) {
                this.closeAllMenus();
            }
        });

        menu.addEventListener('click', async (e) => {
            const item = e.target.closest('.vkey-menu-item');
            if (!item || item.classList.contains('disabled')) return;
            e.preventDefault(); e.stopPropagation();

            const action = item.dataset.action;
            const windowIndex = item.dataset.window;

            try {
                if (action === 'new-window') {
                    await fetch('/api/tmux/window', { method: 'POST' });
                    await this.fetchPanes();
                } else if (action === 'split-h') {
                    const resp = await fetch('/api/tmux/split', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ direction: 'horizontal' })
                    });
                    if (!resp.ok) { const data = await resp.json(); this.showToast(data.error || 'Split failed'); }
                    else { await this.fetchPanes(); }
                } else if (action === 'split-v') {
                    const resp = await fetch('/api/tmux/split', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ direction: 'vertical' })
                    });
                    if (!resp.ok) { const data = await resp.json(); this.showToast(data.error || 'Split failed'); }
                    else { await this.fetchPanes(); }
                } else if (action === 'switch-pane') {
                    await fetch('/api/tmux/pane/switch', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ direction: 'next' })
                    });
                } else if (action === 'close-pane') {
                    const resp = await fetch('/api/tmux/pane/close', { method: 'POST' });
                    if (resp.ok) await this.fetchPanes();
                } else if (action === 'rename-window') {
                    const newName = prompt('Enter new window name:');
                    if (newName && newName.trim()) {
                        const resp = await fetch(`/api/tmux/window/${this.activeWindowIndex}`, {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: newName.trim() })
                        });
                        if (resp.ok) this.showToast('Window renamed');
                        await this.fetchWindows();
                    }
                } else if (action === 'close-window') {
                    const resp = await fetch(`/api/tmux/window/${this.activeWindowIndex}`, { method: 'DELETE' });
                    if (!resp.ok) { const data = await resp.json(); this.showToast(data.error || 'Close failed'); }
                    else { await this.fetchWindows(); await this.fetchPanes(); }
                } else if (windowIndex !== undefined) {
                    await fetch(`/api/tmux/window/${windowIndex}`, { method: 'POST' });
                    await this.fetchPanes();
                }
            } catch (error) { console.error('Window action failed:', error); }

            menu.classList.remove('open');
            this.terminal.focus();
        });
    }

    async fetchWindows() {
        const windowList = document.getElementById('window-list');
        if (!windowList) return;
        try {
            const response = await fetch('/api/tmux/windows');
            const data = await response.json();
            if (!data.enabled) { windowList.innerHTML = '<div class="vkey-menu-item disabled">Tmux not enabled</div>'; return; }
            if (data.windows.length === 0) { windowList.innerHTML = '<div class="vkey-menu-item disabled">No windows</div>'; return; }
            windowList.innerHTML = data.windows.map(win => `
                <div class="vkey-menu-item ${win.active ? 'active' : ''}" data-window="${win.index}">
                    ${win.active ? '●' : '○'} ${win.index}: ${win.name}
                </div>
            `).join('');
            const activeWin = data.windows.find(w => w.active);
            this.activeWindowIndex = activeWin ? activeWin.index : 0;
            const closeBtn = document.getElementById('close-window-btn');
            if (closeBtn) {
                if (data.windows.length <= 1) closeBtn.classList.add('disabled');
                else closeBtn.classList.remove('disabled');
            }
        } catch (error) {
            windowList.innerHTML = '<div class="vkey-menu-item disabled">Load failed</div>';
        }
    }

    async fetchPanes() {
        const paneCountEl = document.getElementById('pane-count');
        const splitHBtn = document.getElementById('split-h-btn');
        const splitVBtn = document.getElementById('split-v-btn');
        const switchPaneBtn = document.getElementById('switch-pane-btn');
        const closePaneBtn = document.getElementById('close-pane-btn');
        try {
            const response = await fetch('/api/tmux/panes');
            const data = await response.json();
            if (!data.enabled) { if (paneCountEl) paneCountEl.textContent = '[N/A]'; return; }
            const count = data.count || 1;
            if (paneCountEl) paneCountEl.textContent = `[${count} pane${count > 1 ? 's' : ''}]`;
            if (count >= 2) {
                if (splitHBtn) splitHBtn.classList.add('disabled');
                if (splitVBtn) splitVBtn.classList.add('disabled');
                if (switchPaneBtn) switchPaneBtn.classList.remove('disabled');
                if (closePaneBtn) closePaneBtn.classList.remove('disabled');
            } else {
                if (splitHBtn) splitHBtn.classList.remove('disabled');
                if (splitVBtn) splitVBtn.classList.remove('disabled');
                if (switchPaneBtn) switchPaneBtn.classList.add('disabled');
                if (closePaneBtn) closePaneBtn.classList.add('disabled');
            }
        } catch (error) {
            if (paneCountEl) paneCountEl.textContent = '[?]';
        }
    }

    setupArrowMenu() {
        const menuBtn = document.getElementById('arrow-menu-btn');
        const panel = document.getElementById('arrow-panel');
        if (!menuBtn || !panel) return;
        menuBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const isOpen = panel.classList.contains('open');
            if (isOpen) { panel.classList.remove('open'); }
            else {
                this.closeAllMenus();
                panel.classList.add('open');
                const btnRect = menuBtn.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                const panelLeft = btnRect.left + (btnRect.width / 2) - (panelRect.width / 2);
                const clampedLeft = Math.max(8, Math.min(panelLeft, window.innerWidth - panelRect.width - 8));
                panel.style.left = clampedLeft + 'px';
                panel.style.bottom = (window.innerHeight - btnRect.top + 8) + 'px';
            }
        });
    }

    setupSimpleMenu(btnId, menuId) {
        const menuBtn = document.getElementById(btnId);
        const menu = document.getElementById(menuId);
        if (!menuBtn || !menu) return;

        menuBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const isOpen = menu.classList.contains('open');
            this.closeAllMenus();
            if (!isOpen) {
                menu.classList.add('open');
                const btnRect = menuBtn.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                const menuLeft = btnRect.left + (btnRect.width / 2) - (menuRect.width / 2);
                const clampedLeft = Math.max(8, Math.min(menuLeft, window.innerWidth - menuRect.width - 8));
                menu.style.left = clampedLeft + 'px';
                menu.style.bottom = (window.innerHeight - btnRect.top + 8) + 'px';
            }
        });

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.vkey-menu-item');
            if (!item) return;
            e.preventDefault(); e.stopPropagation();

            if (item.dataset.key) {
                let keyData = '';
                switch (item.dataset.key) {
                    case 'Tab': keyData = '\t'; break;
                    case 'ShiftTab': keyData = '\x1b[Z'; break;
                }
                if (keyData && this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'input', data: keyData }));
                }
            } else if (item.dataset.action === 'select') {
                this.openSelectionOverlay();
            } else if (item.dataset.action === 'paste') {
                menu.classList.remove('open');
                this.openPasteOverlay();
                return; // don't call terminal.focus() — overlay needs focus
            }

            menu.classList.remove('open');
            this.terminal.focus();
        });
    }

    closeAllMenus() {
        ['window-menu', 'arrow-panel', 'tab-menu', 'edit-menu'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('open');
        });
    }

    openSelectionOverlay() {
        const overlay = document.getElementById('selection-overlay');
        const content = document.getElementById('selection-content');
        if (!overlay || !content || !this.terminal) return;
        const MAX_LINES = 5000;
        const buffer = this.terminal.buffer.active;
        const totalLines = buffer.length;
        const startLine = Math.max(0, totalLines - MAX_LINES);
        const lines = [];
        for (let i = startLine; i < totalLines; i++) {
            const line = buffer.getLine(i);
            if (line) lines.push(line.translateToString(true));
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        content.textContent = lines.join('\n');
        overlay.classList.add('open');
        content.scrollTop = content.scrollHeight;
    }

    closeSelectionOverlay() {
        const overlay = document.getElementById('selection-overlay');
        if (overlay) overlay.classList.remove('open');
        window.getSelection()?.removeAllRanges();
        const content = document.getElementById('selection-content');
        if (content) content.textContent = '';
        if (this.terminal) this.terminal.focus();
    }

    setupSelectionOverlay() {
        const overlay = document.getElementById('selection-overlay');
        const closeBtn = document.getElementById('selection-close-btn');
        const copyBtn = document.getElementById('selection-copy-btn');
        const allBtn = document.getElementById('selection-all-btn');
        const content = document.getElementById('selection-content');
        if (!overlay) return;

        closeBtn?.addEventListener('click', () => this.closeSelectionOverlay());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('open')) this.closeSelectionOverlay();
        });

        allBtn?.addEventListener('click', () => {
            if (!content) return;
            const range = document.createRange();
            range.selectNodeContents(content);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        copyBtn?.addEventListener('click', () => {
            const sel = window.getSelection();
            const text = sel ? sel.toString() : '';
            if (!text) { this.showToast('Select text first'); return; }
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => {
                    this.showToast('Copied');
                    this.closeSelectionOverlay();
                }).catch(() => { this.fallbackCopy(text); this.closeSelectionOverlay(); });
            } else { this.fallbackCopy(text); this.closeSelectionOverlay(); }
        });
    }

    openPasteOverlay() {
        const overlay = document.getElementById('paste-overlay');
        const textarea = document.getElementById('paste-overlay-textarea');
        if (!overlay || !textarea) return;
        textarea.value = '';
        this._pasteSent = false;
        overlay.classList.add('open');
        // Focus immediately — must be synchronous within the user gesture (click)
        // so that mobile Safari allows the focus. Safari's native paste popup
        // will appear near the textarea, which is fine.
        textarea.focus();
        this._pasteOverlayTimer = setTimeout(() => this.closePasteOverlay(), 30000);
    }

    closePasteOverlay() {
        const overlay = document.getElementById('paste-overlay');
        if (overlay) overlay.classList.remove('open');
        if (this._pasteOverlayTimer) {
            clearTimeout(this._pasteOverlayTimer);
            this._pasteOverlayTimer = null;
        }
        if (this.terminal) this.terminal.focus();
    }

    setupPasteOverlay() {
        const overlay = document.getElementById('paste-overlay');
        const textarea = document.getElementById('paste-overlay-textarea');
        const closeBtn = document.getElementById('paste-overlay-close');
        if (!overlay || !textarea) return;

        closeBtn?.addEventListener('click', () => this.closePasteOverlay());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('open')) this.closePasteOverlay();
        });

        // Send text to terminal and close overlay
        const sendPaste = (text) => {
            if (!text || this._pasteSent) return;
            this._pasteSent = true;
            textarea.value = '';
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'input', data: text }));
                this.showToast('Pasted');
            } else {
                this.showToast('Not connected');
            }
            this.closePasteOverlay();
        };

        // paste event: read directly from clipboardData (textarea.value is
        // not yet updated when the paste event fires, so reading it via a
        // timer was unreliable and caused intermittent silent failures).
        textarea.addEventListener('paste', (e) => {
            const text = e.clipboardData?.getData('text/plain');
            if (text) {
                e.preventDefault();
                sendPaste(text);
            }
            // If clipboardData is empty (rare), fall through to input event
        });

        // input event: fallback for Safari's native paste button,
        // which may insert text without firing a paste event
        let inputTimer = null;
        textarea.addEventListener('input', () => {
            if (inputTimer) clearTimeout(inputTimer);
            inputTimer = setTimeout(() => {
                inputTimer = null;
                sendPaste(textarea.value);
            }, 50);
        });
    }

    setupImagePaste() {
        // Use capture phase to intercept paste before xterm.js handles it
        document.addEventListener('paste', (e) => {
            if (this.isUploadingImage) return;

            const items = e.clipboardData?.items;
            if (!items) return;

            // Check if clipboard contains text — if so, let the normal text
            // paste flow handle it.  Copying from web pages often includes
            // both text and an auto-generated image representation; we must
            // not hijack those pastes.
            let hasText = false;
            let imageItem = null;
            for (const item of items) {
                if (item.kind === 'string' && (item.type === 'text/plain' || item.type === 'text/html')) {
                    hasText = true;
                }
                if (item.type.startsWith('image/')) {
                    imageItem = item;
                }
            }

            if (!imageItem || hasText) return;

            e.preventDefault();
            e.stopPropagation();

            const blob = imageItem.getAsFile();
            if (!blob) return;

            this.uploadAndPasteImage(blob);
        }, true); // capture phase — fires before xterm.js's bubble handler
    }

    async uploadAndPasteImage(blob) {
        if (this.isUploadingImage) return;
        this.isUploadingImage = true;
        this.closePasteOverlay();
        this.showToast('Uploading image...', 30000);

        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            const resp = await fetch('/api/paste-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: base64 }),
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || 'Upload failed');
            }

            const { path } = await resp.json();

            // Paste the file path into the terminal via bracketed paste
            if (this.terminal) {
                this.terminal.paste(path);
            }

            this.showToast('Image pasted');
        } catch (error) {
            this.showToast(error.message || 'Image paste failed');
        } finally {
            this.isUploadingImage = false;
        }
    }

    showToast(message, duration = 2000) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        if (this.toastTimer) clearTimeout(this.toastTimer);
        toast.textContent = message;
        toast.classList.add('visible');
        this.toastTimer = setTimeout(() => { toast.classList.remove('visible'); this.toastTimer = null; }, duration);
    }

    fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); this.showToast('Copied'); }
        catch (err) { this.showToast('Copy failed'); }
        document.body.removeChild(textarea);
    }
}

document.addEventListener('DOMContentLoaded', () => { new WebClaudeCode(); });
