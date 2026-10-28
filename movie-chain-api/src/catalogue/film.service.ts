import { Injectable } from '@nestjs/common';
import { AuditLog } from '../audit/audit-log.service';
import { badRequest, notFound } from '../common/errors/api-error';
import type { Film } from '../db/schema/catalogue';
import { clampLimit, decodeCursor, toPage } from '../shared/pagination';
import { StorageService } from '../storage/storage.service';
import { currentTenant } from '../tenancy/tenant-context';
import { CatalogueRepository } from './catalogue.repository';
import { MAX_POSTER_BYTES, posterName, sniffImage } from './poster';

const POSTER_URL_TTL_S = 300;

@Injectable()
export class FilmService {
  constructor(
    private readonly repo: CatalogueRepository,
    private readonly storage: StorageService,
    private readonly audit: AuditLog,
  ) {}

  async view(f: Film) {
    return {
      id: f.id,
      title: f.title,
      synopsis: f.synopsis,
      runtime_min: f.runtimeMin,
      rating: f.rating,
      language: f.language,
      release_date: f.releaseDate,
      // short-lived signed URL: the bucket is never public
      poster_url: f.posterKey ? await this.storage.getSignedUrlForKey(f.posterKey, POSTER_URL_TTL_S) : null,
    };
  }

  async create(v: Parameters<CatalogueRepository['insertFilm']>[0]) {
    const f = await this.repo.insertFilm(v);
    await this.audit.record('film.created', 'film', f.id, { title: f.title });
    return this.view(f);
  }

  async list(limitRaw: unknown, cursor: string | undefined) {
    const limit = clampLimit(limitRaw);
    const after = decodeCursor(cursor, 2) as [string, string] | null;
    const page = toPage(await this.repo.listFilms(limit, after), limit, (f) => [f.title.toLowerCase(), f.id]);
    return { items: await Promise.all(page.items.map((f) => this.view(f))), next_cursor: page.next_cursor };
  }

  async get(id: string) {
    return this.view(await this.load(id));
  }

  async update(id: string, patch: Parameters<CatalogueRepository['updateFilm']>[1]) {
    await this.load(id);
    const f = (await this.repo.updateFilm(id, patch))!;
    await this.audit.record('film.updated', 'film', id, { fields: Object.keys(patch) });
    return this.view(f);
  }

  /** Loads the film FIRST: another chain's film id is a 404 before any upload work. */
  async setPoster(id: string, file: { buffer: Buffer; size: number } | undefined) {
    await this.load(id);
    if (!file) throw badRequest('poster_required', 'Send the image as multipart field "poster"');
    if (file.size > MAX_POSTER_BYTES) throw badRequest('poster_too_large', 'Posters must be 2 MB or smaller');
    const kind = sniffImage(file.buffer);
    if (!kind) throw badRequest('poster_type', 'Posters must be JPEG, PNG or WebP');
    const key = await this.storage.putObject(
      currentTenant().tenantId,
      ['films', id, posterName(file.buffer, kind.ext)],
      file.buffer,
      kind.type,
    );
    const f = (await this.repo.updateFilm(id, { posterKey: key }))!;
    await this.audit.record('film.poster_set', 'film', id, { key });
    return this.view(f);
  }

  private async load(id: string): Promise<Film> {
    const f = await this.repo.findFilm(id);
    if (!f) throw notFound();
    return f;
  }
}
