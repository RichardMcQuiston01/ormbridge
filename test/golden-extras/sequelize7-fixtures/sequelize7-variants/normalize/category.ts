import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  HasMany,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'category', timestamps: true, underscored: true })
export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(60))
  @NotNull
  declare name: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare parentId: CreationOptional<string | null>;

  @HasMany(() => Category, {
    foreignKey: { name: 'parentId', onDelete: 'SET NULL' },
    inverse: 'parent',
  })
  declare children?: NonAttribute<Category[]>;

  declare parent?: NonAttribute<Category>;
}
