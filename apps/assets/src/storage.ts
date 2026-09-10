import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand,
  HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.js';
import type { ObjectStore } from './types.js';

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: Config) {
    this.bucket = config.s3Bucket;
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: config.s3ForcePathStyle,
      credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    });
  }

  async ensurePrivateBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    // S3 buckets are private by default. No public bucket policy or ACL is ever installed.
  }

  async createUpload(key: string, contentType: string, expectedBytes: number, expiresSeconds: number) {
    const result = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Expires: expiresSeconds,
      Fields: { 'Content-Type': contentType },
      Conditions: [['content-length-range', expectedBytes, expectedBytes], ['eq', '$Content-Type', contentType]],
    });
    return { url: result.url, fields: result.fields };
  }

  async head(key: string) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return { bytes: result.ContentLength ?? 0, ...(result.ContentType ? { contentType: result.ContentType } : {}) };
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('Source object has no body');
    await pipeline(result.Body as Readable, createWriteStream(path, { flags: 'wx' }));
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getText(key: string): Promise<string> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('Object has no body');
    return result.Body.transformToString('utf-8');
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signDownload(key: string, expiresSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSeconds });
  }
}
