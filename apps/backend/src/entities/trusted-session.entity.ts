import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('trusted_sessions')
export class TrustedSessionEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  member_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
