import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand,
  HeadObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';

export function r2Storage(env, keyFor) {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!/^[a-f0-9]{32}$/i.test(R2_ACCOUNT_ID || '') ||
      !R2_BUCKET?.trim() || !R2_ACCESS_KEY_ID?.trim() || !R2_SECRET_ACCESS_KEY?.trim()) {
    throw new Error('Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
  const bucket = { Bucket: R2_BUCKET };
  const object = key => ({ ...bucket, Key: keyFor(key) });
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(12000) });
  return {
    async put(key, bytes) {
      try {
        await send(new PutObjectCommand({ ...object(key), Body: bytes, IfNoneMatch: '*' }));
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 412) {
          throw Object.assign(new Error('Storage object already exists.'), { code: 'EEXIST', cause: error });
        }
        throw error;
      }
    },
    async read(key) {
      const result = await send(new GetObjectCommand(object(key)));
      return Buffer.from(await result.Body.transformToByteArray());
    },
    delete: key => send(new DeleteObjectCommand(object(key))),
    async stat(key) {
      const result = await send(new HeadObjectCommand(object(key)));
      return { size: result.ContentLength };
    },
    async list() {
      const keys = [];
      let token;
      do {
        const page = await send(new ListObjectsV2Command({ ...bucket, ContinuationToken: token }));
        keys.push(...(page.Contents || []).map(item => item.Key));
        token = page.NextContinuationToken;
      } while (token);
      return keys;
    },
    ping: () => send(new HeadBucketCommand(bucket)),
    close: () => client.destroy(),
  };
}
