import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum ChannelType {
  WHATSAPP = 'whatsapp',
  WEB = 'web',
  EMAIL = 'email',
  INSTAGRAM = 'instagram',
  FACEBOOK = 'facebook',
  MANUAL = 'manual',
  OTHER = 'other',
}

export enum ChannelIdentityType {
  PHONE = 'phone',
  EMAIL = 'email',
  SESSION = 'session',
  PLATFORM_USER_ID = 'platform_user_id',
  CUSTOM = 'custom',
}

export class ChannelIdentityDto {
  @IsEnum(ChannelIdentityType, {
    message:
      'channelIdentity.type debe ser: phone, email, session, platform_user_id o custom',
  })
  type!: ChannelIdentityType;

  @IsString({ message: 'channelIdentity.value debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'channelIdentity.value no debe estar vacío' })
  value!: string;

  @IsString({
    message: 'channelIdentity.normalizedValue debe ser una cadena de texto',
  })
  @IsNotEmpty({ message: 'channelIdentity.normalizedValue no debe estar vacío' })
  normalizedValue!: string;
}

export class MessageRecordDto {
  @IsString({ message: 'messageText debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'messageText no debe estar vacío' })
  messageText!: string;

  @IsDateString({}, { message: 'receivedAt debe ser una fecha ISO válida' })
  receivedAt!: string;

  @IsOptional()
  @IsString({ message: 'externalMessageId debe ser una cadena de texto' })
  externalMessageId?: string;

  @IsOptional()
  @IsObject({ message: 'metadata debe ser un objeto' })
  metadata?: Record<string, unknown>;
}

export class AiInboundPayloadDto {
  @IsUUID('4', { message: 'correlationId debe ser un UUID v4 válido' })
  correlationId!: string;

  @IsString({ message: 'contactKey debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'contactKey no debe estar vacío' })
  contactKey!: string;

  @IsEnum(ChannelType, {
    message:
      'channel debe ser: whatsapp, web, email, instagram, facebook, manual u other',
  })
  channel!: ChannelType;

  @ValidateNested({ message: 'channelIdentity debe ser un objeto válido' })
  @Type(() => ChannelIdentityDto)
  channelIdentity!: ChannelIdentityDto;

  @IsString({ message: 'consolidatedText debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'consolidatedText no debe estar vacío' })
  consolidatedText!: string;

  @IsInt({ message: 'messageCount debe ser un número entero' })
  @Min(1, { message: 'messageCount debe ser al menos 1' })
  messageCount!: number;

  @IsArray({ message: 'messages debe ser un array' })
  @ValidateNested({ each: true })
  @Type(() => MessageRecordDto)
  messages!: MessageRecordDto[];

  @IsDateString({}, { message: 'firstReceivedAt debe ser una fecha ISO válida' })
  firstReceivedAt!: string;

  @IsDateString({}, { message: 'lastReceivedAt debe ser una fecha ISO válida' })
  lastReceivedAt!: string;

  @IsOptional()
  @IsObject({ message: 'metadata debe ser un objeto' })
  metadata?: Record<string, unknown>;
}
