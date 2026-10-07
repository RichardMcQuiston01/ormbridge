import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Category } from './category.entity';
import { PostStatus } from './post-status.enum';
import { Tag } from './tag.entity';
import { TimeStamped } from './time-stamped';
import { User } from './user.entity';

@Entity('blog_post')
@Unique(['author', 'title'])
@Index('post_pub_status_idx', ['publishedAt', 'status'])
export class Post extends TimeStamped {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    name: 'public_id',
    type: 'uuid',
    unique: true,
    default: () => 'gen_random_uuid()',
  })
  publicId!: string;

  @Index()
  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column('text')
  body!: string;

  @Column({ type: 'enum', enum: PostStatus, default: PostStatus.Draft })
  status!: PostStatus;

  @Column({ type: 'decimal', precision: 4, scale: 2, nullable: true })
  rating!: string | null;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount!: number;

  @Column({ name: 'is_featured', type: 'boolean', default: false })
  isFeatured!: boolean;

  @Column({
    name: 'published_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  publishedAt!: Date;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @ManyToOne(() => User, (user) => user.posts, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'author_id' })
  author!: User;

  @ManyToOne(() => User, (user) => user.editedPosts, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'editor_id' })
  editor!: User | null;

  @ManyToOne(() => Category, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  @ManyToMany(() => Tag, (tag) => tag.posts)
  @JoinTable()
  tags!: Tag[];
}
