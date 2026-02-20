class PreviewPanel {
  constructor() {
    this.iframe = null;
    this.currentPort = null;
    this.availablePorts = [];
    this.notifiedPorts = new Set();
    this.checkInterval = null;
    this.isVisible = false;
    this.notificationTimeout = null;
    this.isDropdownOpen = false;
    this.init();
  }

  init() { this.createUI(); this.startPortCheck(); this.setupEventListeners(); }

  createUI() {
    const container = document.createElement('div');
    container.id = 'preview-container';
    container.className = 'preview-container hidden';
    container.innerHTML = `
      <div class="preview-panel">
        <div class="preview-header">
          <div class="preview-url" onclick="event.stopPropagation();">
            <span class="preview-label">Preview:</span>
            <span class="preview-port">localhost:</span>
            <select id="port-selector" class="port-selector">
              <option value="">Select port...</option>
            </select>
          </div>
          <div class="preview-controls">
            <button class="preview-btn" onclick="previewPanel.refresh()" title="Refresh">Reload</button>
            <button class="preview-btn" onclick="previewPanel.openNewTab()" title="Open in new tab">Open</button>
            <button class="preview-btn" onclick="previewPanel.close()" title="Close">X</button>
          </div>
        </div>
        <div class="preview-body">
          <div class="preview-loading" id="preview-loading">
            <div class="loading-spinner"></div>
            <div class="loading-text">Loading preview...</div>
          </div>
          <iframe id="preview-frame" frameborder="0" allow="autoplay; fullscreen"></iframe>
        </div>
      </div>`;
    const mainContainer = document.querySelector('.main-container');
    if (mainContainer) mainContainer.appendChild(container);
    else document.body.appendChild(container);
    this.iframe = document.getElementById('preview-frame');
    this.setupIframeListeners();
    this.setupPortSelector();
  }

  setupIframeListeners() {
    this.iframe.addEventListener('load', () => { document.getElementById('preview-loading').style.display = 'none'; });
    this.iframe.addEventListener('error', () => { this.showError('Failed to load preview'); });
  }

  setupPortSelector() {
    const selector = document.getElementById('port-selector');
    if (!selector) return;
    selector.addEventListener('mousedown', () => { this.isDropdownOpen = true; });
    selector.addEventListener('blur', () => { setTimeout(() => { this.isDropdownOpen = false; }, 200); });
    selector.addEventListener('change', (e) => { e.stopPropagation(); if (e.target.value) this.switchPort(e.target.value); });
    selector.addEventListener('click', (e) => { e.stopPropagation(); });
  }

  async startPortCheck() {
    await this.checkPorts();
    this.checkInterval = setInterval(async () => { await this.checkPorts(); }, 3000);
  }

  async checkPorts() {
    try {
      const response = await fetch('/api/ports');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.ports && data.ports.length > 0) {
        const SERVER_PORT = parseInt(window.location.port) || 3001;
        const BLOCKED_PORTS = [22, 80, 443, SERVER_PORT, 3306, 5432, 6379, 27017, 9200];
        const availablePorts = data.ports.filter(p => !BLOCKED_PORTS.includes(p.port));
        this.availablePorts = availablePorts;
        this.updatePortSelector();
        const newPorts = availablePorts.filter(p => !this.notifiedPorts.has(p.port));
        if (newPorts.length > 0) {
          this.showNotification(newPorts);
          newPorts.forEach(p => this.notifiedPorts.add(p.port));
        }
        const currentPortNumbers = availablePorts.map(p => p.port);
        this.notifiedPorts.forEach(port => { if (!currentPortNumbers.includes(port)) this.notifiedPorts.delete(port); });
      }
    } catch (error) { console.error('Failed to check ports:', error); }
  }

  updatePortSelector() {
    const selector = document.getElementById('port-selector');
    if (!selector || this.isDropdownOpen) return;
    const currentValue = selector.value;
    selector.innerHTML = '<option value="">Select port...</option>';
    this.availablePorts.forEach(portInfo => {
      const option = document.createElement('option');
      option.value = portInfo.port;
      option.textContent = `${portInfo.port} - ${portInfo.type}`;
      selector.appendChild(option);
    });
    if (this.currentPort && this.availablePorts.some(p => p.port === this.currentPort)) selector.value = this.currentPort;
    else if (currentValue && this.availablePorts.some(p => p.port === parseInt(currentValue))) selector.value = currentValue;
  }

  switchPort(port) {
    if (!port) return;
    const portNum = parseInt(port);
    if (isNaN(portNum)) return;
    this.loadPreview(portNum);
  }

  showNotification(ports) {
    document.querySelectorAll('.preview-notification').forEach(n => n.remove());
    const notification = document.createElement('div');
    notification.className = 'preview-notification';
    if (ports.length === 1) {
      const portInfo = ports[0];
      notification.innerHTML = `
        <div class="notification-content">
          <div class="notification-text">
            <strong>Service detected</strong>
            <p>${portInfo.type} on port ${portInfo.port}</p>
          </div>
          <div class="notification-actions">
            <button class="btn-primary" onclick="previewPanel.loadPreview(${portInfo.port}); this.closest('.preview-notification').remove();">Preview</button>
            <button class="btn-secondary" onclick="this.closest('.preview-notification').remove();">X</button>
          </div>
        </div>`;
      document.body.appendChild(notification);
      setTimeout(() => { if (notification.parentElement) notification.remove(); }, 8000);
    } else {
      const portOptions = ports.map(p => `<option value="${p.port}">${p.port} - ${p.type}</option>`).join('');
      notification.innerHTML = `
        <div class="notification-content" onclick="event.stopPropagation();">
          <div class="notification-text">
            <strong>${ports.length} Services detected</strong>
            <p>Select a service to preview:</p>
            <select id="notification-port-selector" class="notification-port-selector">
              <option value="">Choose port...</option>${portOptions}
            </select>
          </div>
          <div class="notification-actions">
            <button class="btn-primary" onclick="const s=document.getElementById('notification-port-selector');if(s.value){previewPanel.loadPreview(parseInt(s.value));this.closest('.preview-notification').remove();}">Preview</button>
            <button class="btn-secondary" onclick="this.closest('.preview-notification').remove();">X</button>
          </div>
        </div>`;
      document.body.appendChild(notification);
    }
  }

  loadPreview(port) {
    this.currentPort = port;
    document.getElementById('preview-loading').style.display = 'flex';
    this.iframe.src = `/preview/${port}/`;
    const selector = document.getElementById('port-selector');
    if (selector) selector.value = port;
    this.show();
  }

  show() {
    document.getElementById('preview-container').classList.remove('hidden');
    document.body.classList.add('split-view');
    this.isVisible = true;
  }

  close() {
    document.getElementById('preview-container').classList.add('hidden');
    document.body.classList.remove('split-view');
    this.isVisible = false;
    this.currentPort = null;
    if (this.iframe) this.iframe.src = 'about:blank';
  }

  refresh() {
    if (this.iframe && this.currentPort) {
      document.getElementById('preview-loading').style.display = 'flex';
      const currentSrc = this.iframe.src;
      this.iframe.src = 'about:blank';
      setTimeout(() => { this.iframe.src = currentSrc; }, 10);
    }
  }

  openNewTab() { if (this.currentPort) window.open(`/preview/${this.currentPort}/`, '_blank'); }

  showError(message) {
    const loadingEl = document.getElementById('preview-loading');
    if (loadingEl) {
      loadingEl.textContent = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'error-text';
      errorDiv.textContent = message;
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-primary';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => previewPanel.refresh());
      loadingEl.appendChild(errorDiv);
      loadingEl.appendChild(retryBtn);
      loadingEl.style.display = 'flex';
    }
  }

  setupEventListeners() {
    window.addEventListener('beforeunload', () => {
      if (this.checkInterval) clearInterval(this.checkInterval);
      if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && this.isVisible) { e.preventDefault(); this.close(); }
    });
  }

  static getInstance() {
    if (!window._previewPanelInstance) window._previewPanelInstance = new PreviewPanel();
    return window._previewPanelInstance;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { window.previewPanel = PreviewPanel.getInstance(); });
} else {
  window.previewPanel = PreviewPanel.getInstance();
}
