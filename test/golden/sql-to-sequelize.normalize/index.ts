import type { Sequelize } from 'sequelize';
import { BlogUser } from './blogUser.js';
import { BlogCategory } from './blogCategory.js';
import { BlogTag } from './blogTag.js';
import { BlogPost } from './blogPost.js';
import { BlogProfile } from './blogProfile.js';

export { BlogUser, BlogCategory, BlogTag, BlogPost, BlogProfile };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  BlogUser.initModel(sequelize);
  BlogCategory.initModel(sequelize);
  BlogTag.initModel(sequelize);
  BlogPost.initModel(sequelize);
  BlogProfile.initModel(sequelize);

  BlogCategory.belongsTo(BlogCategory, {
    as: 'parent',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });
  BlogCategory.hasMany(BlogCategory, {
    as: 'blogCategories',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });

  BlogPost.belongsTo(BlogUser, {
    as: 'author',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });
  BlogUser.hasMany(BlogPost, {
    as: 'authorBlogPosts',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });

  BlogPost.belongsTo(BlogUser, {
    as: 'editor',
    foreignKey: 'editorId',
    onDelete: 'SET NULL',
  });
  BlogUser.hasMany(BlogPost, {
    as: 'editorBlogPosts',
    foreignKey: 'editorId',
    onDelete: 'SET NULL',
  });

  BlogPost.belongsTo(BlogCategory, {
    as: 'category',
    foreignKey: 'categoryId',
    onDelete: 'RESTRICT',
  });
  BlogCategory.hasMany(BlogPost, {
    as: 'blogPosts',
    foreignKey: 'categoryId',
    onDelete: 'RESTRICT',
  });

  BlogPost.belongsToMany(BlogTag, {
    as: 'tags',
    through: 'blog_post_tags',
    foreignKey: 'blog_post_id',
    otherKey: 'blog_tag_id',
    timestamps: false,
  });
  BlogTag.belongsToMany(BlogPost, {
    as: 'blogPosts',
    through: 'blog_post_tags',
    foreignKey: 'blog_tag_id',
    otherKey: 'blog_post_id',
    timestamps: false,
  });

  BlogProfile.belongsTo(BlogUser, {
    as: 'user',
    foreignKey: 'userId',
    onDelete: 'CASCADE',
  });
  BlogUser.hasOne(BlogProfile, {
    as: 'blogProfile',
    foreignKey: 'userId',
    onDelete: 'CASCADE',
  });

  return { BlogUser, BlogCategory, BlogTag, BlogPost, BlogProfile };
}

export type Models = ReturnType<typeof initModels>;
