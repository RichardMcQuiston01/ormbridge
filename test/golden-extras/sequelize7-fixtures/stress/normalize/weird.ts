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
  BelongsTo,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Other } from './other.js';

@Table({ tableName: 'weird', timestamps: true, underscored: true })
export class Weird extends Model<
  InferAttributes<Weird>,
  InferCreationAttributes<Weird>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default('x;y')
  declare aB: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default('say "hi"')
  declare quote: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default('a`b')
  declare tick: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare selfId: CreationOptional<string | null>;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare otherId: string;

  @BelongsTo(() => Weird, {
    foreignKey: { name: 'selfId', onDelete: 'SET NULL' },
  })
  declare self?: NonAttribute<Weird>;

  @BelongsTo(() => Other, {
    foreignKey: { name: 'otherId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'weirds' },
  })
  declare other?: NonAttribute<Other>;
}
