import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('blog_profile')
export class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, (user) => user.profile, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  avatar!: string | null;
}
