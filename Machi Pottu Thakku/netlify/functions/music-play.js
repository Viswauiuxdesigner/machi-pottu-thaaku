const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

exports.handler = async (event, context) => {
    try {
        const key = event.queryStringParameters.key;
        if (!key) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required query parameter: key" }) };
        }

        // Security Validation 1: Prevent path traversal
        if (key.includes('..') || key.startsWith('/')) {
            return { statusCode: 403, body: JSON.stringify({ error: "Invalid key format." }) };
        }

        // Security Validation 2: Ensure valid audio extension
        const validExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.aac'];
        const extMatch = key.match(/\.[0-9a-z]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        if (!validExtensions.includes(ext)) {
            return { statusCode: 403, body: JSON.stringify({ error: "Forbidden file type." }) };
        }

        const accessKeyId = process.env.FILEBASE_ACCESS_KEY;
        const secretAccessKey = process.env.FILEBASE_SECRET_KEY;
        const bucketName = process.env.FILEBASE_BUCKET;
        const endpoint = process.env.FILEBASE_ENDPOINT || "https://s3.filebase.com";
        
        if (!accessKeyId || !secretAccessKey || !bucketName) {
            return { statusCode: 500, body: JSON.stringify({ error: "Missing required Filebase environment variables." }) };
        }

        const s3 = new S3Client({
            endpoint: endpoint,
            region: 'us-east-1',
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey
            },
            forcePathStyle: false // Virtual hosted-style for Filebase
        });

        // Security Validation 3: Ensure object actually exists in the bucket
        try {
            await s3.send(new HeadObjectCommand({
                Bucket: bucketName,
                Key: key
            }));
        } catch (err) {
            console.error("HeadObject Error:", err.message);
            return { statusCode: 404, body: JSON.stringify({ error: "File not found in bucket." }) };
        }

        // Generate Presigned URL
        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: key
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // Valid for 1 hour

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({ url: signedUrl })
        };

    } catch (error) {
        console.error("Filebase Presign Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
