import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.QUEUE_HOST || 'localhost',
  port: parseInt(process.env.QUEUE_PORT, 10) || 6379,
  // Key prefix of the job queues. Processes share queues only when they
  // share a prefix.
  prefix: process.env.QUEUE_PREFIX || 'bull',
}));
