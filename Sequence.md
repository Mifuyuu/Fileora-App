# Sequence Diagrams for Fileora-App

This document contains sequence diagrams illustrating the different file upload processes in the Fileora-App project.

## 1. Web Client Flow

This diagram shows the process when a user uploads a file through the web interface. The user starts on a primary device (e.g., a PC) and uses a secondary device (e.g., a phone) to scan a QR code and upload the file.

```mermaid
sequenceDiagram
    participant PC as User's PC (Browser)
    participant Server as Node.js Server
    participant Phone as User's Phone (Browser)
    participant DB as MongoDB

    PC->>Server: GET /api/session/init (Click "Scan to Upload")
    activate Server
    Server->>Server: Generate sessionId & QR Code
    Server->>PC: Response { sessionId, qr }
    deactivate Server
    
    PC->>PC: Display QR Code Popup
    
    PC->>Server: WebSocket connection initiated
    activate Server
    Server->>PC: WebSocket connection established
    PC->>Server: Send { type: 'REGISTER_SESSION', sessionId }
    Server->>Server: Store WebSocket client
    deactivate Server

    Note over Phone: User scans QR on PC with their Phone
    Phone->>Server: GET /upload?sessionId=...
    activate Server
    Server->>Phone: Serve upload page (upload.html)
    deactivate Server
    
    Phone->>Phone: User selects a file
    Phone->>Server: POST /api/upload (multipart/form-data with file)
    activate Server
    Server->>Server: Find/Create Session, generate keys
    Server->>Server: Validate, Encrypt & Save file
    
    activate DB
    Server->>DB: Save file metadata to Session
    DB->>Server: Confirm save
    deactivate DB
    
    Server->>Phone: Response { success: true }
    
    Server->>PC: WebSocket message { type: 'FILE_UPLOADED', key: accessKey }
    deactivate Server
    
    PC->>PC: Close QR Popup, show notification
    PC->>Server: GET /api/search/{accessKey}
    activate Server
    
    activate DB
    Server->>DB: Find Session by accessKey
    DB->>Server: Return Session document
    deactivate DB
    
    Server->>PC: Response { files: [...] }
    deactivate Server
    PC->>PC: Display search results

```

## 2. Discord Bot Flow

This diagram illustrates how a user uploads a file by sending it as a direct message to the Discord Bot.

```mermaid
sequenceDiagram
    participant User as Discord User
    participant Discord as Discord API
    participant Server as Node.js Server
    participant DB as MongoDB

    User->>Discord: Sends DM with file attachment
    activate Discord
    Discord->>Server: Event: MessageCreate (with attachment URL)
    deactivate Discord
    activate Server
    
    Server->>Server: Check if message is DM & has attachment
    
    activate Discord
    Server->>Discord: GET attachment.url (Download file stream)
    Discord->>Server: File stream
    deactivate Discord
    
    Server->>Server: Generate sessionId, encryptionKey
    Server->>Server: processAndSaveFile(stream)
    
    activate DB
    Server->>DB: new Session({..., files:[...]}).save()
    DB->>Server: Confirm save
    deactivate DB
    
    activate Discord
    Server->>Discord: Reply to message with accessKey
    Discord->>User: Show bot's reply "✅ Upload successful! ..."
    deactivate Discord
    
    deactivate Server

```

## 3. Line Webhook Flow

This diagram shows the process for a file upload via a LINE Official Account.

```mermaid
sequenceDiagram
    participant User as LINE User
    participant LINE as LINE Platform
    participant Server as Node.js Server
    participant DB as MongoDB

    User->>LINE: Sends file (image, video, etc.) to OA
    activate LINE
    LINE->>Server: POST /line-webhook (Message Event)
    deactivate LINE
    activate Server
    
    activate LINE
    Server->>LINE: getProfile(userId)
    LINE->>Server: User Profile (displayName)
    deactivate LINE
    
    activate LINE
    Server->>LINE: getMessageContent(messageId)
    LINE->>Server: File stream
    deactivate LINE
    
    Server->>Server: Generate sessionId, encryptionKey
    Server->>Server: processAndSaveFile(stream)
    
    activate DB
    Server->>DB: new Session({..., files:[...]}).save()
    DB->>Server: Confirm save
    deactivate DB
    
    activate LINE
    Server->>LINE: replyMessage(replyToken, { text: "✅ ... key is: ..." })
    LINE->>User: Show reply message with the access key
    deactivate LINE
    
    deactivate Server

```