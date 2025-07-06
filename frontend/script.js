const scanBtn = document.getElementById('scanBtn');
const githubBtn = document.getElementById('githubBtn');

const qrPopup = document.getElementById('qrPopup');
const qrImage = document.getElementById('qrImage');
const qrSessionText = document.getElementById('qrSessionText');
const closeQr = document.getElementById('closeQr');

const uploadPopup = document.getElementById('uploadPopup');
const uploadStatus = document.getElementById('uploadStatus');
const downloadLinks = document.getElementById('downloadLinks');
const closeUpload = document.getElementById('closeUpload');

const searchInputField = document.getElementById('searchInput');
const searchIcon = document.querySelector('.labelforsearch');
const mainSearchResults = document.getElementById('mainSearchResults');

const notificationSound = document.getElementById('notificationSound');

let ws;

scanBtn.onclick = async () => {
    const res = await fetch('/api/session');
    const data = await res.json();

    qrImage.src = data.qr;
    qrSessionText.textContent = `Session ID: ${data.sessionID}`;
    qrPopup.classList.remove('hidden');

    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'REGISTER_SESSION', sessionID: data.sessionID }));
    };
    ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'FILE_UPLOADED') {
            qrPopup.classList.add('hidden');
            showUploadPopup(msg.data);
        }
    };
};

closeQr.onclick = () => {
    qrPopup.classList.add('hidden');
    qrSessionText.textContent = '';
}
closeUpload.onclick = () => uploadPopup.classList.add('hidden');

function showUploadPopup(data) {
    uploadStatus.textContent = `File: ${data.filename}\nKey: ${data.key}`;
    downloadLinks.innerHTML = '';
    const a = document.createElement('a');
    a.href = data.downloadUrl;
    notificationSound.play();
    a.innerText = '⬇️ Download File';
    a.target = '_blank';
    downloadLinks.appendChild(a);
    uploadPopup.classList.remove('hidden');
}

async function performSearch() {
    const key = searchInputField.value.toUpperCase().trim();
    if (!key || key.length !== 5) {
        // อาจจะแสดง feedback ที่ดีกว่า alert() เช่น เขย่า input
        mainSearchResults.innerHTML = `<p class="search-error">Please enter a valid 5-character key.</p>`;

        setTimeout(() => {
            mainSearchResults.innerHTML = '';
        }, 3000);

        return;
    }

    mainSearchResults.innerHTML = `<p class="search-info">Searching for key: ${key}...</p>`;

    try {
        const res = await fetch(`/api/search/${key}`);
        if (!res.ok) throw new Error('Key not found or expired.');

        const data = await res.json();
        mainSearchResults.innerHTML = '';

        if (data.files.length === 0) {
            mainSearchResults.innerHTML = `<p class="search-info">No files found for this key.</p>`;
            return;
        }

        const resultTitle = document.createElement('h3');
        resultTitle.textContent = `Files for key: ${key}`;
        mainSearchResults.appendChild(resultTitle);

        data.files.forEach(url => {
            const a = document.createElement('a');
            const fileName = decodeURIComponent(url.split('/').pop());
            a.href = url;
            a.innerText = `⬇️ ${fileName}`;
            a.target = '_blank';
            a.className = 'search-result-link';
            mainSearchResults.appendChild(a);
        });

    } catch (error) {
        mainSearchResults.innerHTML = `<p class="search-error">${error.message}</p>`;
        setTimeout(() => {
            mainSearchResults.innerHTML = '';
        }, 3000);
    }
}

searchInputField.addEventListener('input', function () {
    this.value = this.value.toUpperCase();
});

searchIcon.addEventListener('click', performSearch);

searchInputField.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        performSearch();
    }
});

githubBtn.onclick = () => {
    window.open('https://github.com/Mifuyuu', '_blank');
};

const themeToggle = document.getElementById('theme-toggle');
const body = document.body;

function setTheme(theme) {
    body.setAttribute('data-theme', theme);
    themeToggle.checked = (theme === 'dark');
    localStorage.setItem('theme', theme);
}

themeToggle.addEventListener('change', () => {
    if (themeToggle.checked) {
        setTheme('dark');
    } else {
        setTheme('light');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme);
});