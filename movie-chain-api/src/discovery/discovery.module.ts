import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';

@Module({ controllers: [DiscoveryController], providers: [DiscoveryRepository, DiscoveryService] })
export class PublicDiscoveryModule {}
