const scanBtn = document.getElementById('scanBtn');
const githubBtn = document.getElementById('githubBtn');
const mainContainer = document.getElementById('mainContainer');

const qrPopup = document.getElementById('qrPopup');
const qrImage = document.getElementById('qrImage');
const qrInfoText = document.getElementById('qrInfoText');
const closeQr = document.getElementById('closeQr');

const searchInputField = document.getElementById('searchInput');
const searchContainer = document.getElementById('searchContainer');
const searchIcon = document.querySelector('.labelforsearch');
const mainSearchResults = document.getElementById('mainSearchResults');
const notificationSound = document.getElementById('notificationSound');

const uploadPopup = document.getElementById('uploadPopup');
const uploadPopupTitle = document.getElementById('uploadPopupTitle');
const uploadPopupContent = document.getElementById('uploadPopupContent');

const closeUploadPopup = document.getElementById('closeUploadPopup'); 

let ws;

// --- Functions ---
function showUploadNotification(key) {
    uploadPopupTitle.textContent = "✅ File Received!";
    uploadPopupContent.innerHTML = `File upload complete for key: <strong>${key}</strong>. The results are now displayed below.`;
    uploadPopup.classList.remove('hidden');
    notificationSound.play();
}

function displaySearchResults(files, key) {
    mainSearchResults.innerHTML = '';
    if (files.length === 0) {
        mainSearchResults.innerHTML = `<p class="search-info">No files found for this key.</p>`;
        return;
    }

    const resultTitle = document.createElement('h3');
    resultTitle.textContent = `Files for key: ${key}`;
    mainSearchResults.appendChild(resultTitle);

    files.forEach(file => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'result-item';
        
        const header = document.createElement('div');
        header.className = 'result-item-header';
        
        const fileNameSpan = document.createElement('span');
        fileNameSpan.className = 'filename';
        fileNameSpan.textContent = file.originalname;
        
        const downloadBtn = document.createElement('a');
        downloadBtn.href = file.downloadUrl;
        downloadBtn.className = 'download-btn';
        downloadBtn.textContent = 'Download';
        downloadBtn.setAttribute('download', file.originalname);

        header.appendChild(fileNameSpan);
        header.appendChild(downloadBtn);
        
        const senderDiv = document.createElement('div');
        senderDiv.className = 'sender-info';
        
        let iconClass = 'bi-browser-chrome icon-web';
        if (file.sender.platform === 'Discord') iconClass = 'bi-discord icon-discord';
        if (file.sender.platform === 'LINE') iconClass = 'bi-line icon-line';
        
        senderDiv.innerHTML = `<i class="bi ${iconClass}"></i><span>from ${file.sender.name}</span>`;
        
        itemDiv.appendChild(header);
        itemDiv.appendChild(senderDiv);
        mainSearchResults.appendChild(itemDiv);
    });
}

function handleSearchError() {
    mainContainer.classList.add('container-error');
    setTimeout(() => {
        mainContainer.classList.remove('container-error');
    }, 600);
}

async function performSearch() {
    const key = searchInputField.value.toUpperCase().trim();
    if (!key || key.length !== 5) {
        handleSearchError();
        return;
    }

    try {
        const res = await fetch(`/api/search/${key}`);
        if (!res.ok) throw new Error('Key not found or expired.');
        const data = await res.json();
        displaySearchResults(data.files, key);
    } catch (error) {
        console.error('Search failed:', error);
        handleSearchError();
        mainSearchResults.innerHTML = '';
    }
}

// --- Event Listeners ---
scanBtn.onclick = async () => {
    try {
        const res = await fetch('/api/session');
        if (!res.ok) throw new Error('Failed to fetch session from server.');
        const data = await res.json();
        
        qrImage.src = data.qr;
        qrInfoText.innerHTML = `Your key: <strong>${data.key}</strong><span>Waiting for upload...</span>`;
        qrPopup.classList.remove('hidden');

        if (ws) ws.close();
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
        
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'REGISTER_SESSION', sessionId: data.sessionId }));
        };
        
        ws.onmessage = e => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'FILE_UPLOADED') {
                    qrPopup.classList.add('hidden');
                    searchInputField.value = data.key;
                    performSearch();
                    showUploadNotification(data.key);
                }
            } catch (err) {
                console.error("Error processing WebSocket message:", err);
            }
        };
        ws.onerror = (err) => {
            console.error("WebSocket Error:", err);
            qrInfoText.innerHTML += `<span style="color:red; display:block; margin-top:5px;">Connection failed.</span>`;
        };
    } catch (error) {
        console.error("Session creation failed:", error);
        alert("Could not start a new session. Please try again.");
    }
};

closeQr.onclick = () => {
    qrPopup.classList.add('hidden');
    if (ws) ws.close();
};

closeUploadPopup.onclick = () => {
    uploadPopup.classList.add('hidden');
};

githubBtn.onclick = () => window.open('https://github.com/Mifuyuu', '_blank');
searchInputField.addEventListener('input', function() { this.value = this.value.toUpperCase(); });
searchContainer.addEventListener('click', () => searchInputField.focus());
searchInputField.addEventListener('keypress', (e) => { if (e.key === 'Enter') performSearch(); });
searchIcon.addEventListener('click', performSearch);

// --- Theme Management ---
document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    const body = document.body;
    function setTheme(theme) { 
        body.setAttribute('data-theme', theme); 
        themeToggle.checked = (theme === 'dark'); 
        localStorage.setItem('theme', theme); 
    }
    themeToggle.addEventListener('change', () => setTheme(themeToggle.checked ? 'dark' : 'light'));
    
    // Load saved theme or default to dark
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme);
});