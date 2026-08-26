const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

exports.handler = async (event, context) => {
    try {
        // Securely load environment variables
        const accessKeyId = process.env.FILEBASE_ACCESS_KEY;
        const secretAccessKey = process.env.FILEBASE_SECRET_KEY;
        const bucketName = process.env.FILEBASE_BUCKET;
        const endpoint = process.env.FILEBASE_ENDPOINT || "https://s3.filebase.com";
        
        console.log("[FILEBASE LIBRARY] Function called");
        console.log(`[FILEBASE LIBRARY] Bucket: ${bucketName}`);

        if (!accessKeyId || !secretAccessKey || !bucketName) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: "Missing required Filebase environment variables." })
            };
        }

        const s3 = new S3Client({
            endpoint: endpoint,
            region: 'us-east-1', // Required by AWS SDK, Filebase uses us-east-1 equivalent
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey
            },
            forcePathStyle: false // Filebase requires virtual hosted-style for bucket resolution
        });

        let allObjects = [];
        let isTruncated = true;
        let continuationToken = undefined;

        // Handle pagination to support 1000+ songs
        while (isTruncated) {
            const command = new ListObjectsV2Command({
                Bucket: bucketName,
                MaxKeys: 1000,
                ContinuationToken: continuationToken
            });
            
            const response = await s3.send(command);
            if (response.Contents) {
                allObjects.push(...response.Contents);
            }
            isTruncated = response.IsTruncated;
            continuationToken = response.NextContinuationToken;
        }

        const validExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.aac'];
        let songs = [];
        let index = 1;

        // Parse category from folder names
        const formatCategory = (folderName) => {
            if (!folderName) return "uncategorized";
            
            const lower = folderName.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (lower.includes('newrelease')) return 'tamil-new-releases';
            if (lower.includes('melod')) return 'tamil-melodies';
            if (lower.includes('love')) return 'tamil-love-songs';
            if (lower.includes('old') || lower.includes('classic')) return 'tamil-old-classics';
            if (lower.includes('flok') || lower.includes('folk')) return 'tamil-folk-songs';
            
            return folderName.toLowerCase().replace(/\s+/g, '-');
        };

        allObjects.forEach(obj => {
            const key = obj.Key;
            
            // Ignore folder-marker objects
            if (key.endsWith('/')) return;
            
            // Check extension
            const extMatch = key.match(/\.[0-9a-z]+$/i);
            const ext = extMatch ? extMatch[0].toLowerCase() : '';
            if (!validExtensions.includes(ext)) return;

            // Determine parts
            const parts = key.split('/');
            const filename = parts.pop();
            const folder = parts.length > 0 ? parts[parts.length - 1] : '';

            // Derive metadata
            const title = filename.replace(/\.[^/.]+$/, ""); // Strip extension
            const category = formatCategory(folder);
            
            // Public URL - Use user's specified public io endpoint structure
            const pathSegments = key.split('/').map(segment => encodeURIComponent(segment));
            const audioUrl = `https://${bucketName}.s3.filebase.io/${pathSegments.join('/')}`;
            
            // Default placeholder thumbnail based on category
            let thumbnail = "https://picsum.photos/seed/mpt/500/500";
            if (folder) thumbnail = `https://picsum.photos/seed/${folder}/500/500`;

            songs.push({
                id: `fb-song-${index++}`,
                title: title,
                artist: "Unknown Artist",
                album: "Single",
                category: category,
                year: new Date().getFullYear(),
                thumbnail: thumbnail,
                s3Key: key, // Added raw S3 key for presigned URL generation
                audioUrl: audioUrl,
                duration: 0
            });
        });

        console.log(`[FILEBASE LIBRARY] Objects found: ${allObjects.length}`);
        console.log(`[FILEBASE LIBRARY] Audio files: ${songs.length}`);
        const sampleKeys = songs.slice(0, 3).map(s => s.s3Key);
        console.log(`[FILEBASE LIBRARY] Sample keys: ${JSON.stringify(sampleKeys)}`);
        console.log("[FILEBASE LIBRARY] Library ready");

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // Allow local dev testing
            },
            body: JSON.stringify({ songs: songs })
        };

    } catch (error) {
        console.error("Filebase API Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
