import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('scenarios')
export class ScenarioEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  trusted_session_id!: string;

  @Column({ type: 'int' })
  week!: number;

  @Column({ type: 'text' })
  question!: string;

  @Column({ type: 'text' })
  answer!: string;
}
