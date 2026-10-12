import type { Sequelize } from 'sequelize';
import { Author } from './author.js';
import { Profile } from './profile.js';
import { Post } from './post.js';
import { Category } from './category.js';
import { Tag } from './tag.js';
import { PostTag } from './postTag.js';

export { Author, Profile, Post, Category, Tag, PostTag };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Author.initModel(sequelize);
  Profile.initModel(sequelize);
  Post.initModel(sequelize);
  Category.initModel(sequelize);
  Tag.initModel(sequelize);
  PostTag.initModel(sequelize);

  Profile.belongsTo(Author, {
    as: 'author',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });
  Author.hasOne(Profile, {
    as: 'profile',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });

  Post.belongsTo(Author, {
    as: 'author',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });
  Author.hasMany(Post, {
    as: 'posts',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });

  Post.belongsTo(Category, {
    as: 'category',
    foreignKey: 'categoryId',
    onDelete: 'SET NULL',
  });
  Category.hasMany(Post, {
    as: 'posts',
    foreignKey: 'categoryId',
    onDelete: 'SET NULL',
  });

  Category.belongsTo(Category, {
    as: 'parent',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });
  Category.hasMany(Category, {
    as: 'children',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });

  PostTag.belongsTo(Post, {
    as: 'post',
    foreignKey: 'postId',
    onDelete: 'CASCADE',
  });

  PostTag.belongsTo(Tag, {
    as: 'tag',
    foreignKey: 'tagId',
    onDelete: 'CASCADE',
  });

  return { Author, Profile, Post, Category, Tag, PostTag };
}

export type Models = ReturnType<typeof initModels>;
