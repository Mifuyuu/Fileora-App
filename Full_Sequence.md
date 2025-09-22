# Full System Sequence Diagram

This diagram provides a comprehensive overview of the entire Fileora-App system, combining the three main upload methods (Web, Discord, LINE) and the subsequent common task of searching for and downloading the file.

```mermaid
sequenceDiagram
    participant User
    participant Client as Web Client (PC)
    participant Phone as Web Client (Phone)
    participant Discord
    participant LINE
    participant Server as Node.js Server
    participant DB as MongoDB
    participant FS as File System

    alt Web Client Upload Flow
        Client->>Server: GET /api/session/init
        activate Server
        Server->>Client: { sessionId, qr }
        deactivate Server

        Client->>Server: WebSocket Connect & Register
        
        Note over Phone, Client: User scans QR with Phone
        Phone->>Server: GET /upload?sessionId=...
        activate Server
        Server->>Phone: Upload Page
        deactivate Server

        Phone->>Server: POST /api/upload (with file)
        activate Server
        Server->>Server: Validate, Encrypt, Save file to FS
        Server->>DB: Save Session & file metadata
        Server->>Phone: { success: true }
        Server->>Client: WebSocket message { key: accessKey }
        deactivate Server
        Client->>User: Display accessKey & results

    else Discord Bot Upload Flow
        User->>Discord: DM to Bot with file
        activate Discord
        Discord->>Server: MessageCreate Event
        deactivate Discord
        activate Server
        Server->>Discord: Download file from URL
        activate Discord
        Discord->>Server: File Stream
        deactivate Discord
        Server->>Server: Validate, Encrypt, Save file to FS
        Server->>DB: Save Session & file metadata
        Server->>Discord: Reply with { accessKey }
        activate Discord
        Discord->>User: Show reply with key
        deactivate Discord
        deactivate Server

    else LINE Webhook Upload Flow
        User->>LINE: Send file to OA
        activate LINE
        LINE->>Server: POST /line-webhook
        deactivate LINE
        activate Server
        Server->>LINE: Get file content
        activate LINE
        LINE->>Server: File Stream
        deactivate LINE
        Server->>Server: Validate, Encrypt, Save file to FS
        Server->>DB: Save Session & file metadata
        Server->>LINE: Reply with { accessKey }
        activate LINE
        LINE->>User: Show reply with key
        deactivate LINE
        deactivate Server
    end

    Note over User, Server: Later, user wants to download the file...

    User->>Client: Enter accessKey
    Client->>Server: GET /api/search/{key}
    activate Server
    Server->>DB: Find Session by key
    activate DB
    DB->>Server: Session data
    deactivate DB
    Server->>Client: { files: [...] with download URLs }
    deactivate Server

    Client->>User: Display file list
    User->>Client: Click Download
    Client->>Server: GET /api/download/{sessionId}/{filename}
    activate Server
    Server->>DB: Find Session for decryption info
    activate DB
    DB->>Server: Session data
    deactivate DB
    Server->>FS: Read encrypted file
    activate FS
    FS->>Server: Encrypted stream
    deactivate FS
    Server->>Server: Decrypt stream
    Server->>Client: Decrypted file stream
    deactivate Server
    Client->>User: Save downloaded file
```
