import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'sup3rsecret' })
  @IsString()
  // Checked against an existing hash, so only a DoS bound -- a password
  // set before new ones were capped at 128 must still sign in.
  @MaxLength(1024)
  password: string;
}
