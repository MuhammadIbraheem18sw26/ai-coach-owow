import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('private_chats')
export class PrivateChatEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  member_id!: string;

  @Column({ type: 'varchar', length: 32, default: 'private_chat' })
  visibility!: string;

  @Column({ type: 'varchar', length: 32, default: 'member' })
  sender_role!: string;

  @Column({ type: 'int', default: 1 })
  week!: number;

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
