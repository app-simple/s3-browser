import type { ProviderPreset, ProviderId } from './types'

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'aws',
    label: 'Amazon S3',
    endpointTemplate: '',
    regions: [
      'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
      'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1',
      'ca-central-1', 'sa-east-1',
      'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1',
      'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3',
      'me-central-1', 'af-south-1'
    ],
    defaultRegion: 'eu-central-1',
    forcePathStyle: false,
    hint: 'Uses the official AWS endpoints. Leave the endpoint field empty.'
  },
  {
    id: 'minio',
    label: 'MinIO / self-hosted',
    endpointTemplate: 'http://localhost:9000',
    regions: ['us-east-1'],
    defaultRegion: 'us-east-1',
    forcePathStyle: true,
    customEndpoint: true,
    hint: 'Path-style addressing. Adjust host and port to your MinIO instance.'
  },
  {
    id: 'hetzner',
    label: 'Hetzner Object Storage',
    endpointTemplate: 'https://{region}.your-objectstorage.com',
    regions: ['fsn1', 'nbg1', 'hel1'],
    defaultRegion: 'fsn1',
    forcePathStyle: true,
    hint: 'Location fsn1 (Falkenstein), nbg1 (Nuremberg) or hel1 (Helsinki).'
  },
  {
    id: 'backblaze',
    label: 'Backblaze B2',
    endpointTemplate: 'https://s3.{region}.backblazeb2.com',
    regions: ['us-west-000', 'us-west-001', 'us-west-002', 'us-west-004', 'us-east-005', 'eu-central-003'],
    defaultRegion: 'eu-central-003',
    forcePathStyle: false,
    hint: 'The region is shown as part of your bucket endpoint in the B2 console.'
  },
  {
    id: 'wasabi',
    label: 'Wasabi',
    endpointTemplate: 'https://s3.{region}.wasabisys.com',
    regions: [
      'us-east-1', 'us-east-2', 'us-central-1', 'us-west-1',
      'ca-central-1', 'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-south-1',
      'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2'
    ],
    defaultRegion: 'eu-central-1',
    forcePathStyle: false
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean Spaces',
    endpointTemplate: 'https://{region}.digitaloceanspaces.com',
    regions: ['nyc3', 'sfo2', 'sfo3', 'ams3', 'sgp1', 'fra1', 'syd1', 'blr1', 'tor1'],
    defaultRegion: 'fra1',
    forcePathStyle: false
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare R2',
    endpointTemplate: 'https://{accountId}.r2.cloudflarestorage.com',
    regions: ['auto'],
    defaultRegion: 'auto',
    forcePathStyle: true,
    customEndpoint: true,
    hint: 'Replace {accountId} with your Cloudflare account ID. Region stays "auto".'
  },
  {
    id: 'scaleway',
    label: 'Scaleway Object Storage',
    endpointTemplate: 'https://s3.{region}.scw.cloud',
    regions: ['fr-par', 'nl-ams', 'pl-waw'],
    defaultRegion: 'fr-par',
    forcePathStyle: false
  },
  {
    id: 'ionos',
    label: 'IONOS Object Storage',
    endpointTemplate: 'https://s3-{region}.ionoscloud.com',
    regions: ['eu-central-1', 'eu-central-2', 'eu-south-2', 'de'],
    defaultRegion: 'eu-central-2',
    forcePathStyle: true
  },
  {
    id: 'storj',
    label: 'Storj',
    endpointTemplate: 'https://gateway.storjshare.io',
    regions: ['us-east-1'],
    defaultRegion: 'us-east-1',
    forcePathStyle: true
  },
  {
    id: 'custom',
    label: 'Other S3-compatible',
    endpointTemplate: 'https://',
    regions: ['us-east-1'],
    defaultRegion: 'us-east-1',
    forcePathStyle: true,
    customEndpoint: true,
    hint: 'Any S3-compatible endpoint. If listing buckets fails, toggle path-style addressing.'
  }
]

export function getProvider(id: ProviderId): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
}

export function buildEndpoint(id: ProviderId, region: string): string {
  const preset = getProvider(id)
  return preset.endpointTemplate.replace('{region}', region)
}
