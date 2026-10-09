import { Column, Entity, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Post } from './post.entity';

@Entity('blog_tag')
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  label!: string;

  @ManyToMany(() => Post, (post) => post.tags)
  posts!: Post[];
}
