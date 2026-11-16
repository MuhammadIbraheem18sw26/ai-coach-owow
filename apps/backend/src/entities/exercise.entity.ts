import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('exercises')
export class ExerciseEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  member_id!: string;

  @Column({ type: 'varchar', length: 32, default: 'exercise' })
  visibility!: string;

  @Column({ type: 'int' })
  week!: number;

  @Column({ type: 'text', nullable: true })
  question!: string | null;

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
