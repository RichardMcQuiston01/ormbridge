import 'reflect-metadata';
import {
  AllowNull,
  AutoIncrement,
  BelongsTo,
  BelongsToMany,
  Column,
  Comment,
  CreatedAt,
  DataType,
  Default,
  DeletedAt,
  ForeignKey,
  HasMany,
  HasOne,
  Index,
  Model,
  PrimaryKey,
  Sequelize,
  Table,
  Unique,
  UpdatedAt,
} from 'sequelize-typescript';

// sequelize-typescript: decorated classes, with the foreign keys found through @ForeignKey. Properties
// that point at a class declared further down are typed `| null`, which keeps the emitted decorator
// metadata from reading the class before it exists.
@Table({ tableName: 'authors', paranoid: true })
export class Author extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  id!: number;

  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(80))
  email!: string;

  @Column(DataType.TEXT)
  bio!: string | null;

  @Default('active')
  @Column(DataType.ENUM('active', 'banned'))
  state!: string;

  // The type comes from the TypeScript type (emitDecoratorMetadata).
  @Column
  nickname!: string;

  @CreatedAt
  createdAt!: Date;

  @UpdatedAt
  updatedAt!: Date;

  @DeletedAt
  deletedAt!: Date | null;

  @HasMany(() => Post)
  posts!: Post[];

  @HasOne(() => Profile)
  profile!: Profile | null;
}

@Table({ tableName: 'profiles', timestamps: false })
export class Profile extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  id!: number;

  @ForeignKey(() => Author)
  @AllowNull(false)
  @Unique
  @Column(DataType.INTEGER)
  authorId!: number;

  @BelongsTo(() => Author, { onDelete: 'CASCADE' })
  author!: Author;
}

// Not underscored: Sequelize creates indexes from the attribute names, which only work as column names.
@Table({ tableName: 'posts' })
export class Post extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  id!: number;

  @Index
  @AllowNull(false)
  @Column(DataType.STRING(200))
  title!: string;

  @Index({ name: 'posts_author_slug', unique: true })
  @AllowNull(false)
  @Column(DataType.STRING(120))
  slug!: string;

  @Index({ name: 'posts_status_idx' })
  @Default('draft')
  @Column(DataType.STRING(20))
  status!: string;

  @Index({ name: 'posts_status_idx' })
  @Comment('When the post went live')
  @Column(DataType.DATE)
  publishedAt!: Date | null;

  @ForeignKey(() => Author)
  @Index({ name: 'posts_author_slug', unique: true })
  @AllowNull(false)
  @Column(DataType.INTEGER)
  authorId!: number;

  @BelongsTo(() => Author)
  author!: Author;

  @ForeignKey(() => Category)
  @Column(DataType.INTEGER)
  categoryId!: number | null;

  @BelongsTo(() => Category, { foreignKey: 'categoryId', onDelete: 'SET NULL' })
  category!: Category | null;

  @BelongsToMany(() => Tag, () => PostTag)
  tags!: Tag[];
}

@Table({ tableName: 'categories', timestamps: false })
export class Category extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  id!: number;

  @Column(DataType.STRING(60))
  name!: string;

  @ForeignKey(() => Category)
  @Column(DataType.INTEGER)
  parentId!: number | null;

  @BelongsTo(() => Category, { foreignKey: 'parentId', onDelete: 'SET NULL' })
  parent!: Category;

  @HasMany(() => Category, 'parentId')
  children!: Category[];

  @HasMany(() => Post)
  posts!: Post[];
}

@Table({ tableName: 'tags', timestamps: false })
export class Tag extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  id!: number;

  @Column(DataType.STRING(40))
  label!: string;

  @BelongsToMany(() => Post, () => PostTag)
  posts!: Post[];
}

// The join model: it has no key of its own, so the two foreign keys become its primary key.
@Table({ tableName: 'post_tags', timestamps: false })
export class PostTag extends Model {
  @ForeignKey(() => Post)
  @Column(DataType.INTEGER)
  postId!: number;

  @ForeignKey(() => Tag)
  @Column(DataType.INTEGER)
  tagId!: number;
}

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: ':memory:',
  logging: false,
  models: [Author, Profile, Post, Category, Tag, PostTag],
});
