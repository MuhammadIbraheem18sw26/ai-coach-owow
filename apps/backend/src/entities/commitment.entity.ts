import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('commitments')
export class CommitmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  member_id!: string;

  @Column({ type: 'varchar', length: 32, default: 'exercise' })
  visibility!: string;

  @Column({ type: 'int' })
  week!: number;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  replaced_by!: string | null;

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
