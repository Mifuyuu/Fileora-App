# Sequence Diagrams for All Other Tasks

This document contains sequence diagrams for additional functionalities in the Fileora-App system that were not covered in the initial upload flows.

## 1. File Search and Download Flow

This diagram illustrates the process where a user, who already has an access key, searches for and downloads the associated files.

```mermaid
sequenceDiagram
    participant User as User (Browser)
    participant Server as Node.js Server
    participant DB as MongoDB
    participant FS as File System

    User->>User: Enters 5-digit key and clicks Search
    User->>Server: GET /api/search/{key}
    activate Server

    Server->>DB: findOne({ accessKey: key })
    activate DB
    DB->>Server: Return Session document
    deactivate DB

    Server->>Server: Map files to include download URLs
    Server->>User: Response { files: [...] }
    deactivate Server

    User->>User: Displays list of files with Download buttons
    User->>User: Clicks a "Download" button

    User->>Server: GET /api/download/{sessionId}/{filename}
    activate Server

    Server->>DB: findOne({ sessionId: ... })
    activate DB
    DB->>Server: Return Session document (with encryptionKey, iv, authTag)
    deactivate DB

    Server->>FS: Read encrypted file stream
    activate FS
    FS->>Server: Encrypted file stream
    deactivate FS

    Server->>Server: Decrypt file stream
    Server->>User: Decrypted file stream (as attachment)
    deactivate Server

    User->>User: Browser prompts to save the file
```

## 2. Orphaned File Cleanup Flow (Cron Job)

This diagram shows the automated background process that runs periodically to clean up stored files that no longer have a valid session in the database.

```mermaid
sequenceDiagram
    participant Scheduler as Cron Scheduler
    participant Server as Node.js Server
    participant FS as File System
    participant DB as MongoDB

    Scheduler->>Server: Trigger scheduled job (e.g., every hour)
    activate Server

    Server->>FS: Read all directory names in '/uploads'
    activate FS
    FS->>Server: List of sessionIds (directory names)
    deactivate FS

    loop For each sessionId from File System
        Server->>DB: findOne({ sessionId: ... })
        activate DB
        DB->>Server: Session document or null
        deactivate DB

        alt Session does NOT exist in DB (is null)
            Server->>FS: Delete directory '/uploads/{sessionId}'
            activate FS
            FS->>Server: Confirm deletion
            deactivate FS
        end
    end

    deactivate Server
```
