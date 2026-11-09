import { UdmtError } from '../errors.js';
import type { CapabilityId, ProviderDescriptor } from '../types.js';
import type { DataProvider } from './contract.js';
import { hasCapability } from './contract.js';
import { MongoDbProvider } from './mongodb.js';
import { MySqlProvider } from './mysql.js';
import { PostgresProvider } from './postgresql.js';
import { RestProvider } from './rest.js';
import { SqliteProvider } from './sqlite.js';

/** Built-in provider registry. External (IPC) providers are a later phase. */
export class ProviderRegistry {
  private readonly providers = new Map<string, DataProvider>();

  constructor() {
    for (const provider of [
      new SqliteProvider(),
      new PostgresProvider(),
      new MySqlProvider(),
      new MongoDbProvider(),
      new RestProvider(),
    ]) {
      this.providers.set(provider.providerId, provider);
    }
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => provider.descriptor());
  }

  /** Registers an external (plugin) provider; built-in ids are never overwritten. */
  register(provider: DataProvider): void {
    if (this.providers.has(provider.providerId)) {
      throw new UdmtError('ALREADY_EXISTS', `Provider "${provider.providerId}" is already registered.`, {
        details: { provider_id: provider.providerId },
      });
    }
    this.providers.set(provider.providerId, provider);
  }

  remove(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): DataProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new UdmtError('CAPABILITY_UNSUPPORTED', `Unknown provider: ${providerId}`, {
        details: { available: [...this.providers.keys()] },
      });
    }
    return provider;
  }

  descriptor(providerId: string): ProviderDescriptor {
    return this.get(providerId).descriptor();
  }

  assertCapability(providerId: string, capability: CapabilityId): void {
    const descriptor = this.descriptor(providerId);
    if (!hasCapability(descriptor, capability)) {
      throw new UdmtError(
        'CAPABILITY_UNSUPPORTED',
        `Provider "${providerId}" does not support ${capability}.`,
        { details: { capability, provider_id: providerId } },
      );
    }
  }

  supports(providerId: string, capability: CapabilityId): boolean {
    const provider = this.providers.get(providerId);
    return provider ? hasCapability(provider.descriptor(), capability) : false;
  }
}
