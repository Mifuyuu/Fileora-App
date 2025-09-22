```mermaid
sequenceDiagram
    actor User
    participant Browser as Browser (UI)
    participant Server as Backend (server.js)
    participant WebSocket
    participant DB as Database (MongoDB)
    participant FS as File System
    
    %% Use Case 1: File Upload via Web UI
    
    box Aqua File Upload via Web UI
        User->>+Browser: 1. Clicks "Scan to Upload"
        Browser->>+Server: 2. GET /api/session/init
        Server-->>-Browser: 3. Returns { sessionId, qrCode }
        Browser->>User: 4. Displays QR Code popup
        User->>User: 5. Scans QR with another device (e.g., phone)
        
        Note over User, Browser: The user is now on the upload page on their other device.
        
        Browser->>+WebSocket: 6. Opens WebSocket connection
        WebSocket->>+Server: 7. Forwards connection
        Server->>Server: 8. Registers WebSocket client with sessionId
        WebSocket-->>-Browser: 9. Connection established
        
        User->>+Server: 10. POST /api/upload?sessionId=... (from other device)
        Server->>+FS: 11. Saves file temporarily
        Server->>+DB: 12. Finds/Creates Session document
        Server->>Server: 13. Encrypts file
        FS->>Server: 14. Returns encrypted file stream
        Server->>+FS: 15. Saves encrypted file
        Server->>FS: 16. Deletes temporary file
        Server->>+DB: 17. Saves file metadata to Session
        DB-->>-Server: 18. Confirms save
        FS-->>-Server: 19. Confirms save
        Server-->>-User: 20. Returns { success: true } (to other device)
        
        Server->>+WebSocket: 21. Sends { type: 'FILE_UPLOADED', key: 'ABCDE' }
        WebSocket->>+Browser: 22. Forwards message to original browser
        Browser->>User: 23. Hides QR, shows "File Received!" notification
        Browser->>Browser: 24. Automatically performs search with the new key
    end
    
    %% Use Case 2: File Search & Download
    
    box LightBlue File Search & Download
        User->>+Browser: 25. Enters 5-digit key and clicks Search
        Browser->>+Server: 26. GET /api/search/{key}
        Server->>+DB: 27. Finds Session by accessKey
        DB-->>-Server: 28. Returns Session document
        Server-->>-Browser: 29. Returns file list (without sensitive data)
        Browser->>User: 30. Displays search results with Download buttons
        
        User->>+Browser: 31. Clicks a Download button
        Browser->>+Server: 32. GET /api/download/{sessionId}/{filename}
        Server->>+DB: 33. Finds Session by sessionId
        DB-->>-Server: 34. Returns Session document (with encryption info)
        Server->>+FS: 35. Reads encrypted file from disk
        FS-->>-Server: 36. Returns file stream
        Server->>Server: 37. Decrypts file stream
        Server-->>-Browser: 38. Streams decrypted file to user
        Browser->>User: 39. File download starts
    end

    %% Use Case 3: File Upload via Bots
    
    actor PlatformUser as LINE/Discord User
    participant Platform as LINE/Discord Platform
    
    box GreenYellow File Upload via Bots
        PlatformUser->>+Platform: 40. Sends a file in chat
        Platform->>+Server: 41. POST /line-webhook (or receives Discord event)
        Server->>Platform: 42. Fetches file content stream
        Platform-->>Server: 43. Returns file stream
        
        Server->>Server: 44. Generates sessionId, encryptionKey
        Server->>Server: 45. processAndSaveFile()
        note right of Server: This involves saving temp file, encrypting, saving final file, deleting temp file. (Steps 11-16)
        
        Server->>+DB: 46. Creates new Session with file metadata
        DB-->>-Server: 47. Confirms save
        Server->>+Platform: 48. Replies with { key: 'FGHIJ' }
        Platform->>PlatformUser: 49. Shows reply message with the key
    end

```
