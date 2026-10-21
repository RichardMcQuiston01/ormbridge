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
  AutoIncrement,
  BelongsToMany,
  CreatedAt,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'people', timestamps: true, underscored: true })
export class Person extends Model<
  InferAttributes<Person>,
  InferCreationAttributes<Person>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(255))
  @NotNull
  declare name: string;

  @Attribute(DataTypes.DATEONLY)
  declare born: CreationOptional<string | null>;

  @Attribute(DataTypes.TIME)
  declare wakeUp: CreationOptional<string | null>;

  @Attribute(DataTypes.BLOB)
  declare photo: CreationOptional<Buffer | null>;

  @Attribute(DataTypes.DOUBLE)
  declare height: CreationOptional<number | null>;

  @Attribute(DataTypes.BIGINT)
  declare rank: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  declare shelf: CreationOptional<number | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.DATE)
  declare deletedAt: CreationOptional<Date | null>;

  @BelongsToMany(() => Person, {
    through: { model: 'people_friends', timestamps: false },
    foreignKey: 'from_person_id',
    otherKey: 'to_person_id',
    inverse: 'friendsInverse',
    throughAssociations: { fromSource: 'friendsLinks', toSource: 'friendsSource', fromTarget: 'friendsInverseLinks', toTarget: 'friendsTarget' },
  })
  declare friends?: NonAttribute<Person[]>;

  declare friendsInverse?: NonAttribute<Person[]>;
}
