# Chronicle — Production Readiness & Rebrand Plan

> Bu doküman, projeyi (`node-mt`) production-grade bir migration aracına (`chronicle`)
> dönüştürmek için yapılması gereken tüm işleri kapsar. İşler öncelik sırasına göre
> fazlara ayrılmıştır. Her madde, dokunulacak dosya(lar) ile birlikte listelenmiştir.

## Hedef

ORM'a bağımlı olmadan; TypeScript-first, checksum drift-detection, advisory lock ve
enterprise policy'lere sahip bir PostgreSQL migration motoru. Piyasadaki Flyway,
golang-migrate, Umzug ve Knex gibi araçlar kadar güvenilir olmak.

---

## Faz 0 — Yeniden Adlandırma (`node-mt` → `chronicle`)

İlk NPM yayınından önce yapılmalı; sonrası çok pahalı.

- [ ] npm scope kontrolü: `@chronicle/*` veya `chronicle-*` müsaitlik taraması
- [ ] Paket adları:
  - `@node-mt/core` → `@chronicle/core`
  - `@node-mt/postgres` → `@chronicle/postgres`
  - `@node-mt/cli` → `chronicle` (bin adı: `chronicle`)
- [ ] Kod içi tüm `node-mt` referansları (`packages/**/package.json`, `src/**`, `README.md`,
      `examples/**`, `scripts/**`, `docker-compose.yml`)
- [ ] Runtime sabitleri:
  - `node_mt_migrations` → `chronicle_migrations`
  - `node_mt_migration_log` → `chronicle_migration_log`
  - Advisory lock adı `node-mt:${namespace}` → `chronicle:${namespace}`
  - **Not:** Tablo/lock adı değişimi geriye dönük uyumluluğu bozar. MVP öncesi olduğu için
    kabul edilebilir; yayın sonrası olsaydı migration/alias gerekirdi.
- [ ] Config dosya adları: `node-mt.config.ts` → `chronicle.config.ts` (eski adı da fallback
      olarak `loadConfig` içinde bir süre destekle)
- [ ] Hata mesajları ve CLI help metinleri

---

## Faz 1 — Schema DSL Tamamlama (Kritik)

`packages/core/src/schema.ts` ve `packages/postgres/src/compiler.ts` genişletilecek.
Her yeni komut için `SchemaCommand` union'a tip, builder'a metod, compiler'a `case` ve test
eklenecek.

### 1.1 Foreign Key Yönetimi
- [ ] `AlterTableBuilder.addForeignKey(columns, options)` — mevcut tabloya FK ekleme
      (`ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...`)
- [ ] `AlterTableBuilder.dropForeignKey(name | columns)` — FK kaldırma
- [ ] Bileşik (composite) FK desteği — `foreignKey([...cols]).references(table, [...cols])`
- [ ] `AlterTableOperation` union'a `addForeignKey` / `dropForeignKey` eklenmesi
- [ ] Constraint isimlendirme stratejisini tutarlı hale getir (şu an `_foreign` sabit son ek)

### 1.2 Sütun Değişiklikleri (`ALTER COLUMN`)
- [ ] `changeType(column, newType)` → `ALTER COLUMN ... TYPE ... USING ...`
- [ ] `setNotNullable(column)` / `setNullable(column)` → `SET/DROP NOT NULL`
- [ ] `setDefault(column, value)` / `dropDefault(column)`
- [ ] `USING` ifadesi için opsiyonel cast desteği (tip dönüşümlerinde şart)

### 1.3 Constraint & Index Yönetimi
- [ ] `AlterTableBuilder.dropIndex(name | columns)`
- [ ] `AlterTableBuilder.dropUnique(name | columns)`
- [ ] `renameIndex(from, to)`
- [ ] Tablo seviyesinde composite primary key: `table.primary([...cols])`
- [ ] `addPrimaryKey` / `dropPrimaryKey` (alter)
- [ ] Named `CHECK` constraint: `table.check(name, expression)` + `dropCheck`
- [ ] Named unique constraint (index'ten ayrı: `ADD CONSTRAINT ... UNIQUE`)

### 1.4 Tablo Seviyesi Operasyonlar
- [ ] `renameTable(from, to)` komutu (`SchemaBuilder` + compiler)
- [ ] `truncate(table, { cascade, restartIdentity })` opsiyonel

---

## Faz 2 — Migration Sistemi (Kritik)

### 2.1 Baseline / Fake Run
- [ ] `chronicle baseline <id>` — mevcut DB için migration'ları çalıştırmadan uygulanmış
      say ve `chronicle_migrations`'a kaydet
- [ ] `up --fake` / `down --fake` flag'leri
- [ ] `Migrator` içinde fake path (SQL çalıştırmadan sadece `recordApplied`/`removeApplied`)
- Dosya: `packages/core/src/migrator.ts`, `packages/cli/src/index.ts`

### 2.2 `down --to <id>`
- [ ] `MigrationRunOptions`'a rollback için `to` desteği
- [ ] `MigrationPlanner.rollback({ to })` — belirli bir id'ye kadar geri alma
- Dosya: `packages/core/src/planner.ts`, `packages/core/src/migrator.ts`, CLI

### 2.3 Çoklu Dizin & Namespace
- [ ] `migrations.directory`'yi `string | string[]` yap
- [ ] `MigrationLoader`'ın birden fazla dizini birleştirmesi (id çakışması kontrolü korunur)
- [ ] Namespace'ler için dokümantasyon ve örnek (multi-tenant senaryosu)
- Dosya: `packages/core/src/loader.ts`, `packages/core/src/config.ts`

### 2.4 Migration Dosya Formatı Doğrulama
- [ ] `<timestamp>_<slug>.ts` formatını `MigrationLoader`'da zorunlu kıl, format hatasında
      açık hata mesajı ver (şu an `jiti` sessizce herhangi bir dosyayı yüklüyor)
- Dosya: `packages/core/src/loader.ts`

### 2.5 Checksum Versiyonlama
- [ ] `chronicle_migrations` tablosuna `checksum_algo` kolonu ekle (varsayılan `sha256`)
- [ ] Planner drift kontrolünde algoritma uyumsuzluğunu ayrı ele al
- Dosya: `packages/postgres/src/repository.ts`, `packages/core/src/planner.ts`

---

## Faz 3 — Güvenilirlik & Dayanıklılık (Kritik)

### 3.1 Statement / Migration Timeout
- [ ] Config'e `execution.statementTimeoutMs` ve `execution.migrationTimeoutMs`
- [ ] PostgreSQL adapter'da her migration session'ı için `SET statement_timeout`
- [ ] Timeout aşımında anlamlı hata + audit log kaydı
- Dosya: `packages/core/src/config.ts`, `packages/postgres/src/adapter.ts`,
  `packages/core/src/migrator.ts`

### 3.2 Kilit Öncesi `ensureReady` Sırası
- [ ] `ensureReady()`'yi advisory lock ALINDIKTAN sonra çağır (şu an lock öncesi)
- [ ] Böylece tablo oluşturma da serileştirilmiş olur
- Dosya: `packages/core/src/migrator.ts` (`#run` içindeki sıralama)

### 3.3 Metadata Tablolarına Index
- [ ] `chronicle_migrations`: `(namespace, batch)` üzerine index
- [ ] `chronicle_migration_log`: `(namespace, migration_id)` ve `(executed_at)` üzerine index
- Dosya: `packages/postgres/src/repository.ts` (`ensureReady`)

### 3.4 Bağlantı Retry
- [ ] Geçici bağlantı hataları için backoff'lu retry (yalnızca idempotent noktalar:
      lock alma, `ensureReady`, `listExecuted`)
- [ ] Retry sayısı ve gecikmesi config'ten ayarlanabilir
- Dosya: `packages/postgres/src/adapter.ts`

### 3.5 Advisory Lock Sağlamlaştırma
- [ ] `pg_try_advisory_lock` (session) korunur; ancak lock alan client migration boyunca
      canlı tutulmalı — kilit alan bağlantının migration'la aynı olmasını doğrula/dokümante et
- [ ] Lock timeout aşımında audit log + net hata (mevcut davranış korunur, test eklenir)
- Dosya: `packages/postgres/src/adapter.ts`

---

## Faz 4 — Test Altyapısı

### 4.1 `@chronicle/testing` Paketi
- [ ] `createTestMigrator(config)` yardımcı fonksiyonu
- [ ] Geçici namespace/schema ile izole test çalıştırma
- [ ] Test sonrası temizlik (drop schema / truncate metadata)
- [ ] Fixture migration üretimi

### 4.2 In-Memory Adapter
- [ ] Testler için hafif in-memory `DatabaseAdapter` (SQL üretimini doğrulamak için,
      gerçek DB gerektirmeden) — dry-run testlerini hızlandırır
- Yeni paket: `packages/testing`

### 4.3 Genişletilmiş Integration Suite
- [ ] Faz 1-3'teki her yeni özellik için PostgreSQL integration testi
- Dosya: `packages/postgres/test/postgres.integration.test.ts`

---

## Faz 5 — Gözlemlenebilirlik & DX

### 5.1 Makine-Okunur Çıktı
- [ ] `status`, `plan`, `verify` için `--format json` flag'i
- [ ] CI pipeline'larının çıktıyı parse edebilmesi
- Dosya: `packages/cli/src/index.ts`

### 5.2 Config Doğrulama
- [ ] `isNodeMtConfig` yerine gerçek şema doğrulama (adapter, migrations, policies alanları)
- [ ] Yanlış/eksik config'te alan bazlı hata mesajları
- Dosya: `packages/core/src/config.ts`

### 5.3 Yapılandırılabilir Logger
- [ ] `EventBus` üzerine hazır bir `createLogger()` (pino/console) adaptörü
- [ ] `sql:statement`, `migration:*` event'lerini structured log olarak yaz
- Dosya: `packages/core/src/events.ts` (+ opsiyonel `packages/core/src/logger.ts`)

---

## Faz 6 — Dokümantasyon & Yayın

- [ ] README'yi `chronicle` markasıyla ve yeni özelliklerle güncelle
- [ ] `examples/postgres-basic`'i güncelle + yeni bir `examples/multi-tenant` ekle
- [ ] Her komut için ayrıntılı doküman (baseline, fake, to, format flag'leri)
- [ ] `CHANGELOG` / changeset'ler
- [ ] `1.0.0` öncesi tam integration + coverage geçişi (`pnpm test`, `pnpm test:integration`)

---

## Öncelik Özeti

| Faz | Konu | Öncelik | Neden |
|-----|------|---------|-------|
| 0 | Rebrand | **Şimdi** | Yayın sonrası pahalı |
| 1 | Schema DSL | **Kritik** | FK/alter olmadan gerçek migration yazılamaz |
| 2 | Migration sistemi | **Kritik** | Baseline olmadan mevcut DB'lere giremez |
| 3 | Güvenilirlik | **Kritik** | Production'da veri güvenliği |
| 4 | Test altyapısı | Yüksek | Kullanıcı güveni |
| 5 | Gözlemlenebilirlik | Orta | CI/CD entegrasyonu |
| 6 | Doküman & yayın | Orta | Benimsenme |

## Kabul Kriterleri (1.0.0)

- Tüm alter/FK/constraint operasyonları desteklenir ve integration testleri geçer
- Mevcut bir veritabanına `baseline` ile sorunsuz giriş yapılabilir
- Eşzamanlı iki `up` koşumu güvenli (lock + ensureReady sıralaması doğru)
- Statement timeout ile takılan migration otomatik kesilir
- `verify --format json` CI'da drift'i exit code 1 ile raporlar
- `@chronicle/testing` ile kullanıcı kendi migration'larını test edebilir
