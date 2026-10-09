import { Entity, OneToMany, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Post } from './post.entity';
import { Profile } from './profile.entity';

@Entity('auth_user')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[];

  @OneToMany(() => Post, (post) => post.editor)
  editedPosts!: Post[];

  @OneToOne(() => Profile, (profile) => profile.user)
  profile!: Profile | null;
}
