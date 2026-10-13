import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Audit } from '../audit/audit.interceptor';
import { Public } from '../auth/decorators';
import { rate } from '../common/rate';
import { Roles } from '../rbac/rbac';
import { DirectoryService } from './directory.service';

/** Public constituency and MP directory: approved, published records only. */
@Public()
@Controller('public')
export class PublicDirectoryController {
  constructor(private readonly dir: DirectoryService) {}

  @Get('regions')
  @Throttle(rate(60))
  regions() {
    return this.dir.regions();
  }

  @Get('constituencies')
  @Throttle(rate(60))
  list(@Query('region') region?: string) {
    return this.dir.listConstituencies(region);
  }

  /** Assisted lookup: returns the match, how it was made, and the current published MP. */
  @Get('constituencies/lookup')
  @Throttle(rate(30))
  lookup(@Query('q') q = '') {
    return this.dir.lookup(String(q).slice(0, 100));
  }

  @Get('constituencies/:id')
  @Throttle(rate(60))
  get(@Param('id') id: string) {
    return this.dir.getPublic(id);
  }
}

class ConstituencyRowDto {
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MinLength(1) @MaxLength(80) region!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) aliases?: string[];
}

class ImportDto {
  @IsString() @MinLength(3) @MaxLength(300) sourceRef!: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ConstituencyRowDto) rows!: ConstituencyRowDto[];
}

class MpDto {
  @IsOptional() @IsString() @MaxLength(200) officialName?: string;
  @IsOptional() @IsString() @MaxLength(100) party?: string;
  @IsOptional() @IsString() @MaxLength(200) roleTitle?: string;
  @IsOptional() @IsObject() publicContact?: Record<string, string>;
  @IsOptional() @IsUUID() constituencyId?: string;
  @IsOptional() @IsDateString() activeFrom?: string;
  @IsOptional() @IsDateString() activeTo?: string;
  @IsOptional() @IsUUID() userId?: string;
}

const toData = (d: MpDto) => ({
  ...d,
  activeFrom: d.activeFrom ? new Date(d.activeFrom) : undefined,
  activeTo: d.activeTo ? new Date(d.activeTo) : undefined,
});

@Controller('internal')
export class InternalDirectoryController {
  constructor(private readonly dir: DirectoryService) {}

  @Get('mps')
  @Roles(Role.STAFF, Role.MP, Role.REVIEWER, Role.ADMIN)
  mps() {
    return this.dir.listMps();
  }

  @Post('mps')
  @Roles(Role.ADMIN)
  @Audit({ action: 'mp.create', objectType: 'mp' })
  createMp(@Body() dto: MpDto) {
    return this.dir.saveMp(null, toData(dto));
  }

  @Patch('mps/:id')
  @Roles(Role.ADMIN)
  @Audit({ action: 'mp.update', objectType: 'mp' })
  updateMp(@Param('id') id: string, @Body() dto: MpDto) {
    return this.dir.saveMp(id, toData(dto));
  }

  @Post('constituencies/import')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @Audit({ action: 'constituency.import', objectType: 'constituency' })
  importConstituencies(@Body() dto: ImportDto) {
    return this.dir.importConstituencies(dto.rows, dto.sourceRef, dto.dryRun ?? false);
  }
}
